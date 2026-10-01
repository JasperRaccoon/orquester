// Per-desktop window tracker (spec §6.2): an in-daemon X11 client that follows the EWMH client
// list, titles, WM_CLASS, maximized state and the active window, maps each window to the app that
// owns it, and performs activate / maximize / close through EWMH ClientMessages.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { DesktopSize, DesktopWindow, DesktopWindowAction } from "@orquester/api";

import { X11Connection, X11ConnectionClosedError, X11Error, x11SocketPath } from "./x11/connection.ts";
import {
  encodeClientMessage,
  EventMask,
  PredefinedAtom,
  propertyStrings,
  propertyUint32s,
  type XEvent
} from "./x11/protocol.ts";
import { readXauthCookie } from "./x11/xauth.ts";
import { XRES_EXTENSION_NAME } from "./x11/xres.ts";

export interface DesktopWindowTrackerOptions {
  /** X display number (`:<n>`). */
  display: number;
  /** The desktop's MIT-MAGIC-COOKIE-1 authority file. */
  xauthorityPath: string;
  /** Map a recorded app process-group id to its app id, or null. */
  appForPgid: (pgid: number) => string | null;
}

export interface DesktopWindowSnapshot {
  windows: DesktopWindow[];
  activeWindowId: string | null;
}

export class DesktopWindowNotFoundError extends Error {}

export interface DesktopWindowTrackerEvents {
  /** Window list, titles, maximized state, active window or app mapping changed. */
  change: [DesktopWindowSnapshot];
  /** Root window resized (RandR / ExtendedDesktopSize from a viewer). */
  resize: [DesktopSize];
  /** Connection lost for good (after retries) or protocol failure. */
  error: [Error];
}

// ---------------------------------------------------------------------------
// Window → app mapping through /proc
// ---------------------------------------------------------------------------

export interface ProcStat {
  ppid: number;
  pgrp: number;
}

/** Parse `/proc/<pid>/stat`; `comm` may contain spaces and parentheses, so split after the last `)`. */
export function parseProcStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  // After ") ": state(3) ppid(4) pgrp(5) …
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
  return { ppid, pgrp };
}

export function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

const MAX_PROC_DEPTH = 128;

/**
 * The app owning `pid`: the first of the process's and its ancestors' process groups that
 * `appForPgid` recognises, stopping at pid 1.
 */
export function appForPid(pid: number, appForPgid: (pgid: number) => string | null, readStat: (pid: number) => ProcStat | null = readProcStat): string | null {
  let current = pid;
  for (let depth = 0; depth < MAX_PROC_DEPTH && current > 1; depth++) {
    const stat = readStat(current);
    if (!stat) return null;
    if (stat.pgrp > 0) {
      const app = appForPgid(stat.pgrp);
      if (app !== null) return app;
    }
    current = stat.ppid;
  }
  return null;
}

export const formatWindowId = (id: number): string => `0x${id.toString(16)}`;

export function parseWindowId(value: string): number | null {
  if (!/^0x[0-9a-f]{1,8}$/i.test(value)) return null;
  const id = Number.parseInt(value.slice(2), 16);
  return id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const ATOM_NAMES = [
  "_NET_CLIENT_LIST",
  "_NET_ACTIVE_WINDOW",
  "_NET_WM_NAME",
  "UTF8_STRING",
  "_NET_WM_STATE",
  "_NET_WM_STATE_MAXIMIZED_VERT",
  "_NET_WM_STATE_MAXIMIZED_HORZ",
  "_NET_CLOSE_WINDOW",
  "_NET_WM_PID"
] as const;
type Atoms = Record<(typeof ATOM_NAMES)[number], number>;

const ROOT_EVENT_MASK = EventMask.PropertyChange | EventMask.StructureNotify;
const CLIENT_EVENT_MASK = EventMask.PropertyChange;
const CLIENT_MESSAGE_MASK = EventMask.SubstructureRedirect | EventMask.SubstructureNotify;
/** EWMH source indication: a pager (direct user action), so the WM honours the request. */
const SOURCE_PAGER = 2;
const NET_WM_STATE_TOGGLE = 2;
const CHANGE_DEBOUNCE_MS = 16;
/** Titles longer than this are cut off. */
const MAX_TITLE_BYTES = 4096;

interface TrackedWindow {
  id: number;
  netWmName: string | null;
  wmName: string | null;
  wmClass: string | null;
  maximized: boolean;
  xresPid: number | null;
  netWmPid: number | null;
  appId: string | null;
}

interface Session {
  conn: X11Connection;
  atoms: Atoms;
  /** X-Resource major opcode, or null when the server lacks the extension. */
  xres: number | null;
}

export class DesktopWindowTracker extends EventEmitter<DesktopWindowTrackerEvents> {
  // Reconnect backoff; protected so tests can shorten them.
  protected reconnectInitialMs = 250;
  protected reconnectMaxMs = 5_000;
  protected reconnectGiveUpMs = 30_000;

  private session: Session | null = null;
  private windows = new Map<number, TrackedWindow>();
  /** Client windows in `_NET_CLIENT_LIST` order. */
  private order: number[] = [];
  private activeWindow = 0;
  private size: DesktopSize | null = null;
  private started = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private changeTimer: NodeJS.Timeout | null = null;
  private lastEmitted = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disconnectedAt: number | null = null;
  private reconnectDelay = 0;

  constructor(readonly options: DesktopWindowTrackerOptions) {
    super();
  }

  /** Connect, authenticate, subscribe to events and read the initial state. Rejects if unreachable. */
  async start(): Promise<void> {
    if (this.started) throw new Error("DesktopWindowTracker already started");
    this.started = true;
    await this.connect();
    this.lastEmitted = JSON.stringify(this.snapshot());
  }

  /** Close the X connection; no more events. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.changeTimer = null;
    this.reconnectTimer = null;
    const session = this.session;
    this.session = null;
    session?.conn.close();
  }

  snapshot(): DesktopWindowSnapshot {
    const windows: DesktopWindow[] = [];
    for (const id of this.order) {
      const w = this.windows.get(id);
      if (!w) continue;
      windows.push({ id: formatWindowId(id), title: w.netWmName ?? w.wmName ?? "", appId: w.appId, wmClass: w.wmClass, maximized: w.maximized });
    }
    return {
      windows,
      activeWindowId: this.activeWindow !== 0 && this.windows.has(this.activeWindow) ? formatWindowId(this.activeWindow) : null
    };
  }

  /** Re-resolve window → app mapping (call after an app launches or exits). */
  refreshApps(): void {
    if (this.stopped) return;
    for (const w of this.windows.values()) w.appId = this.resolveApp(w);
    this.scheduleChange();
  }

  /** Throws DesktopWindowNotFoundError for an unknown window id. */
  async action(windowId: string, action: DesktopWindowAction): Promise<void> {
    const id = parseWindowId(windowId);
    if (id === null || !this.windows.has(id)) throw new DesktopWindowNotFoundError(`Unknown window ${windowId}`);
    const session = this.session;
    if (!session) throw new Error(`X display :${this.options.display} is not connected`);
    const { conn, atoms } = session;
    let message: Buffer;
    switch (action) {
      case "activate":
        message = encodeClientMessage(id, atoms._NET_ACTIVE_WINDOW, [SOURCE_PAGER, 0, this.activeWindow, 0, 0]);
        break;
      case "maximize":
        message = encodeClientMessage(id, atoms._NET_WM_STATE, [
          NET_WM_STATE_TOGGLE,
          atoms._NET_WM_STATE_MAXIMIZED_VERT,
          atoms._NET_WM_STATE_MAXIMIZED_HORZ,
          SOURCE_PAGER,
          0
        ]);
        break;
      case "close":
        message = encodeClientMessage(id, atoms._NET_CLOSE_WINDOW, [0, SOURCE_PAGER, 0, 0, 0]);
        break;
      default:
        throw new Error(`Unknown window action ${String(action)}`);
    }
    await conn.sendEvent(false, conn.root, CLIENT_MESSAGE_MASK, message);
  }

  /** Open the X connection. Overridable so tests can reach the raw connection. */
  protected async openConnection(): Promise<X11Connection> {
    const auth = await readXauthCookie(this.options.xauthorityPath, this.options.display);
    return X11Connection.connect({ path: x11SocketPath(this.options.display), auth });
  }

  private async connect(): Promise<void> {
    const conn = await this.openConnection();
    if (this.stopped) {
      conn.close();
      return;
    }
    conn.on("event", (event) => {
      void this.enqueue(() => this.handleEvent(conn, event)).catch((error) => this.onJobError(conn, error));
    });
    conn.on("close", () => this.onClose(conn));
    try {
      await this.enqueue(() => this.initialize(conn));
    } catch (error) {
      conn.close();
      throw error;
    }
    if (this.stopped) conn.close();
  }

  private async initialize(conn: X11Connection): Promise<void> {
    const atomValues = await Promise.all(ATOM_NAMES.map((name) => conn.internAtom(name)));
    const atoms = Object.fromEntries(ATOM_NAMES.map((name, i) => [name, atomValues[i]!])) as Atoms;
    const extension = await conn.queryExtension(XRES_EXTENSION_NAME);
    let xres: number | null = null;
    if (extension.present) {
      await conn.xresQueryVersion(extension.majorOpcode);
      xres = extension.majorOpcode;
    }
    await conn.selectInput(conn.root, ROOT_EVENT_MASK);
    const geometry = await conn.getGeometry(conn.root);
    if (this.stopped) return;
    // The session becomes current only once fully read, so a close before then is the caller's
    // failure to handle (start() rejects, or the reconnect loop retries), not a second reconnect.
    const session: Session = { conn, atoms, xres };
    this.windows = new Map();
    this.order = [];
    await this.loadClientList(session);
    await this.loadActiveWindow(session);
    if (this.stopped) return;
    this.session = session;
    this.updateSize({ width: geometry.width, height: geometry.height });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private onJobError(conn: X11Connection, error: unknown): void {
    // A closed connection is handled by onClose; X errors mean a window vanished mid-read.
    if (this.stopped || conn.isClosed || error instanceof X11Error || error instanceof X11ConnectionClosedError) return;
    this.fail(error instanceof Error ? error : new Error(String(error)));
  }

  private async handleEvent(conn: X11Connection, event: XEvent): Promise<void> {
    const session = this.session;
    if (this.stopped || !session || session.conn !== conn) return;
    const { atoms } = session;
    switch (event.type) {
      case "PropertyNotify": {
        if (event.window === conn.root) {
          if (event.atom === atoms._NET_CLIENT_LIST) await this.loadClientList(session);
          else if (event.atom === atoms._NET_ACTIVE_WINDOW) await this.loadActiveWindow(session);
          else return;
          break;
        }
        const w = this.windows.get(event.window);
        if (!w) return;
        try {
          if (event.atom === atoms._NET_WM_NAME) w.netWmName = await this.readNetWmName(session, w.id);
          else if (event.atom === PredefinedAtom.WM_NAME) w.wmName = await this.readWmName(session, w.id);
          else if (event.atom === PredefinedAtom.WM_CLASS) w.wmClass = await this.readWmClass(session, w.id);
          else if (event.atom === atoms._NET_WM_STATE) w.maximized = await this.readMaximized(session, w.id);
          else if (event.atom === atoms._NET_WM_PID) {
            w.netWmPid = await this.readNetWmPid(session, w.id);
            w.appId = this.resolveApp(w);
          } else return;
        } catch (error) {
          if (!(error instanceof X11Error)) throw error;
        }
        break;
      }
      case "ConfigureNotify":
        if (event.window !== conn.root) return;
        this.updateSize({ width: event.width, height: event.height });
        return;
      case "DestroyNotify":
        if (!this.windows.delete(event.window)) return;
        this.order = this.order.filter((id) => id !== event.window);
        break;
      default:
        return;
    }
    this.scheduleChange();
  }

  private async loadClientList(session: Session): Promise<void> {
    const { conn, atoms } = session;
    const property = await conn.getProperty(conn.root, atoms._NET_CLIENT_LIST, PredefinedAtom.WINDOW);
    const ids = property?.format === 32 ? propertyUint32s(property.value).filter((id) => id !== 0) : [];
    const listed = new Set(ids);
    for (const id of this.windows.keys()) if (!listed.has(id)) this.windows.delete(id);
    const added = ids.filter((id) => !this.windows.has(id));
    const loaded = await Promise.all(added.map((id) => this.loadWindow(session, id)));
    for (const w of loaded) if (w) this.windows.set(w.id, w);
    this.order = ids.filter((id) => this.windows.has(id));
  }

  /** Subscribe to a client window and read its properties; null when it vanished meanwhile. */
  private async loadWindow(session: Session, id: number): Promise<TrackedWindow | null> {
    try {
      await session.conn.selectInput(id, CLIENT_EVENT_MASK);
      const [netWmName, wmName, wmClass, maximized, netWmPid, xresPid] = await Promise.all([
        this.readNetWmName(session, id),
        this.readWmName(session, id),
        this.readWmClass(session, id),
        this.readMaximized(session, id),
        this.readNetWmPid(session, id),
        session.xres === null ? Promise.resolve(null) : session.conn.xresClientPid(session.xres, id)
      ]);
      const w: TrackedWindow = { id, netWmName, wmName, wmClass, maximized, xresPid, netWmPid, appId: null };
      w.appId = this.resolveApp(w);
      return w;
    } catch (error) {
      if (error instanceof X11Error) return null;
      throw error;
    }
  }

  private async loadActiveWindow(session: Session): Promise<void> {
    const { conn, atoms } = session;
    const property = await conn.getProperty(conn.root, atoms._NET_ACTIVE_WINDOW, PredefinedAtom.WINDOW);
    this.activeWindow = property?.format === 32 ? (propertyUint32s(property.value)[0] ?? 0) : 0;
  }

  private async readNetWmName(session: Session, id: number): Promise<string | null> {
    const property = await session.conn.getProperty(id, session.atoms._NET_WM_NAME, session.atoms.UTF8_STRING, MAX_TITLE_BYTES);
    return property?.format === 8 && property.type === session.atoms.UTF8_STRING ? property.value.toString("utf8") : null;
  }

  private async readWmName(session: Session, id: number): Promise<string | null> {
    const property = await session.conn.getProperty(id, PredefinedAtom.WM_NAME, undefined, MAX_TITLE_BYTES);
    if (property?.format !== 8) return null;
    // STRING is Latin-1; UTF8_STRING and anything else (COMPOUND_TEXT) are read as UTF-8, best effort.
    return property.value.toString(property.type === PredefinedAtom.STRING ? "latin1" : "utf8");
  }

  private async readWmClass(session: Session, id: number): Promise<string | null> {
    const property = await session.conn.getProperty(id, PredefinedAtom.WM_CLASS, undefined, MAX_TITLE_BYTES);
    if (property?.format !== 8) return null;
    const [instance, cls] = propertyStrings(property.value, "latin1");
    return cls || instance || null;
  }

  private async readMaximized(session: Session, id: number): Promise<boolean> {
    const { atoms } = session;
    const property = await session.conn.getProperty(id, atoms._NET_WM_STATE, PredefinedAtom.ATOM);
    if (property?.format !== 32) return false;
    const states = propertyUint32s(property.value);
    return states.includes(atoms._NET_WM_STATE_MAXIMIZED_VERT) && states.includes(atoms._NET_WM_STATE_MAXIMIZED_HORZ);
  }

  private async readNetWmPid(session: Session, id: number): Promise<number | null> {
    const property = await session.conn.getProperty(id, session.atoms._NET_WM_PID, PredefinedAtom.CARDINAL);
    const pid = property?.format === 32 ? propertyUint32s(property.value)[0] : undefined;
    return pid && pid > 0 ? pid : null;
  }

  /** XRes gives the owning client's pid; `_NET_WM_PID` is only a fallback when it is unknown. */
  private resolveApp(w: TrackedWindow): string | null {
    const pid = w.xresPid ?? w.netWmPid;
    return pid === null ? null : appForPid(pid, this.options.appForPgid);
  }

  private updateSize(size: DesktopSize): void {
    const previous = this.size;
    this.size = size;
    if (previous && (previous.width !== size.width || previous.height !== size.height) && !this.stopped) this.emit("resize", size);
  }

  private scheduleChange(): void {
    if (this.stopped || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (this.stopped) return;
      const snapshot = this.snapshot();
      const key = JSON.stringify(snapshot);
      if (key === this.lastEmitted) return;
      this.lastEmitted = key;
      this.emit("change", snapshot);
    }, CHANGE_DEBOUNCE_MS);
  }

  private onClose(conn: X11Connection): void {
    if (this.stopped || this.session?.conn !== conn) return;
    this.session = null;
    this.disconnectedAt = Date.now();
    this.reconnectDelay = this.reconnectInitialMs;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.disconnectedAt === null) return;
    const elapsed = Date.now() - this.disconnectedAt;
    if (elapsed >= this.reconnectGiveUpMs) {
      this.disconnectedAt = null;
      this.windows.clear();
      this.order = [];
      this.activeWindow = 0;
      this.fail(new Error(`Lost the X connection to display :${this.options.display} and could not reconnect`));
      return;
    }
    const delay = Math.min(this.reconnectDelay, this.reconnectGiveUpMs - elapsed);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(
        () => {
          if (this.stopped) return;
          this.disconnectedAt = null;
          this.scheduleChange();
        },
        () => this.scheduleReconnect()
      );
    }, delay);
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    // An unhandled 'error' event would throw; the manager listens, but never crash the daemon.
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}
