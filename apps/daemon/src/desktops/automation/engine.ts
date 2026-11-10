// The desktop automation engine (spec 2026-11-10 §2.3): one X11 client per running desktop, with
// its own connection and the desktop's authority, that
//
// - captures the screen (GetImage in bands, converted to RGB through the root visual's masks),
// - follows every change through a RawRectangles DAMAGE on the root: each DamageNotify bumps the
//   screen sequence and stamps the 16×16 blocks it covers, so waits for "idle" and "change" run
//   on events plus one deadline timer, never by polling; a wait's region is watched at that block
//   granularity (damage in a block the region touches counts, live and from the grid alike),
// - injects input with XTEST only, binding a keysym the keymap lacks to a spare keycode (kept in
//   an LRU of 8, restored when evicted or on close), and releasing whatever an input call pressed
//   even when it fails halfway,
// - owns and reads the CLIPBOARD selection through an unmapped InputOnly helper window.
//
// Input and clipboard calls run one at a time; captures and waits run alongside them. An input
// call's signal stops it before its turn or between its steps.

import { DESKTOP_CLIPBOARD_MAX_BYTES, DESKTOP_TYPE_MAX_CHARS, type DesktopModifier, type DesktopRect, type DesktopSize } from "@orquester/api";

import { MAX_SERVER_MESSAGE_BYTES, X11Connection, X11ConnectionClosedError } from "../x11/connection.ts";
import {
  decodeDamageNotify,
  DAMAGE_EXTENSION_NAME,
  DAMAGE_NOTIFY,
  DamageReportLevel,
  encodeDamageCreate,
  encodeDamageDestroy,
  encodeDamageQueryVersion,
  encodeDamageSubtract,
  encodeXFixesQueryVersion,
  XFIXES_EXTENSION_NAME,
  type DamageRect
} from "../x11/damage.ts";
import {
  AnyPropertyType,
  encodeChangeKeyboardMapping,
  encodeChangeProperty,
  encodeConvertSelection,
  encodeCreateWindow,
  encodeDeleteProperty,
  encodeSelectionNotify,
  encodeSendEvent,
  encodeSetSelectionOwner,
  EventMask,
  MappingRequest,
  None,
  PredefinedAtom,
  PropertyMode,
  WindowClass,
  type KeyboardMapping,
  type SetupInfo,
  type XEvent
} from "../x11/protocol.ts";
import { findMitCookie, parseXauthority } from "../x11/xauth.ts";
import { encodeXTestFakeInput, encodeXTestGetVersion, FakeEventType, XTEST_EXTENSION_NAME, type FakeInput } from "../x11/xtest.ts";
import { Keysym, keysymsForText, letterCases, parseCombo, type ComboKey } from "./keys.ts";
import {
  DesktopAutomationError,
  type DesktopAutomation,
  type DesktopCapture,
  type DesktopWaitOptions,
  type DesktopWaitResult,
  type OpenDesktopAutomation,
  type XButton
} from "./types.ts";

/** A GetImage band's pixel bytes: the reply (with its 32-byte header) stays within the connection's cap. */
const CAPTURE_BAND_BYTES = MAX_SERVER_MESSAGE_BYTES - 32;
/** Damage grid block edge, in display pixels. */
const BLOCK = 16;
/** Input events between sync barriers. */
const SYNC_EVERY = 50;
const CLICK_INTERVAL_MS = 60;
const DRAG_STEPS = 10;
const DRAG_STEP_MS = 20;
/** Keysyms bound to spare keycodes at once. */
const TEMP_BINDINGS = 8;
const CLIPBOARD_TIMEOUT_MS = 2_000;
/** close() gives up on a server that does not answer its clean-up and drops the connection. */
const CLOSE_TIMEOUT_MS = 5_000;
const TRUE_COLOR = 4;
const DIRECT_COLOR = 5;

const MODIFIER_KEYSYMS: Readonly<Record<DesktopModifier, readonly number[]>> = {
  shift: [Keysym.Shift_L, Keysym.Shift_R],
  ctrl: [Keysym.Control_L, Keysym.Control_R],
  alt: [Keysym.Alt_L, Keysym.Alt_R, Keysym.Meta_L, Keysym.Meta_R],
  super: [Keysym.Super_L, Keysym.Super_R]
};

const ATOM_NAMES = ["CLIPBOARD", "UTF8_STRING", "TARGETS", "TEXT", "INCR", "_ORQUESTER_SELECTION", "_ORQUESTER_TIMESTAMP"] as const;
type Atoms = Record<(typeof ATOM_NAMES)[number], number>;

export const openDesktopAutomation: OpenDesktopAutomation = async (target) => {
  const auth = findMitCookie(parseXauthority(await target.readAuthority()), target.display);
  let conn: X11Connection;
  try {
    conn = await X11Connection.handshake(await target.connect(), auth);
  } catch (error) {
    throw notRunning(error);
  }
  try {
    return await X11DesktopAutomation.open(conn);
  } catch (error) {
    conn.close();
    throw notRunning(error);
  }
};

/** A dropped connection is the desktop going away; anything else is passed on. */
function notRunning(error: unknown): unknown {
  return error instanceof X11ConnectionClosedError ? new DesktopAutomationError("DESKTOP_NOT_RUNNING", "The desktop's X display is not reachable.") : error;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Keyboard {
  minKeycode: number;
  maxKeycode: number;
  mapping: KeyboardMapping;
  /** Shift, Lock, Control, Mod1…Mod5: the keycodes that set each. */
  modifiers: number[][];
}

interface Waiter {
  /** Display pixels (watched by the 16×16 blocks it touches), or null for the whole screen. */
  region: DesktopRect | null;
  /** Damage (or a resize) touched the region; `seq` is the new screen sequence. */
  changed(seq: number): void;
  fail(error: Error): void;
}

interface OwnedClipboard {
  text: string;
  utf8: Buffer;
  /** The server time the selection was acquired at. */
  time: number;
}

/** Pixel conversion for the root visual: 32-bit pixels in the server's image byte order → RGB. */
type PixelConverter = (src: Buffer, dst: Buffer, dstOffset: number, pixels: number) => void;

function pixelConverter(setup: SetupInfo): PixelConverter {
  const screen = setup.screens[0]!;
  const visual = screen.rootVisual;
  const format = setup.pixmapFormats.find((entry) => entry.depth === screen.rootDepth);
  if (!visual || (visual.class !== TRUE_COLOR && visual.class !== DIRECT_COLOR) || (screen.rootDepth !== 24 && screen.rootDepth !== 32) || format?.bitsPerPixel !== 32) {
    throw new DesktopAutomationError(
      "DESKTOP_UNSUPPORTED_VISUAL",
      `The display's visual (depth ${screen.rootDepth}, ${format?.bitsPerPixel ?? "?"} bits per pixel) cannot be captured; only 24/32-bit TrueColor is supported.`
    );
  }
  const lsb = setup.imageByteOrder === "lsb";
  const { redMask, greenMask, blueMask } = visual;
  if (redMask === 0xff0000 && greenMask === 0xff00 && blueMask === 0xff) {
    // The usual layout: B G R X in memory (LSBFirst), X R G B (MSBFirst).
    const [r, g, b] = lsb ? [2, 1, 0] : [1, 2, 3];
    return (src, dst, dstOffset, pixels) => {
      for (let i = 0, s = 0, d = dstOffset; i < pixels; i++, s += 4, d += 3) {
        dst[d] = src[s + r]!;
        dst[d + 1] = src[s + g]!;
        dst[d + 2] = src[s + b]!;
      }
    };
  }
  const channel = (mask: number): { mask: number; shift: number; scale: Uint8Array } => {
    let shift = 0;
    while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++;
    const max = mask >>> shift;
    const scale = new Uint8Array(max + 1);
    for (let v = 0; v <= max; v++) scale[v] = Math.round((v * 255) / max);
    return { mask, shift, scale };
  };
  const red = channel(redMask);
  const green = channel(greenMask);
  const blue = channel(blueMask);
  return (src, dst, dstOffset, pixels) => {
    for (let i = 0, s = 0, d = dstOffset; i < pixels; i++, s += 4, d += 3) {
      const pixel = lsb ? src.readUInt32LE(s) : src.readUInt32BE(s);
      dst[d] = red.scale[(pixel & red.mask) >>> red.shift]!;
      dst[d + 1] = green.scale[(pixel & green.mask) >>> green.shift]!;
      dst[d + 2] = blue.scale[(pixel & blue.mask) >>> blue.shift]!;
    }
  };
}

interface BlockRange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const overlaps = (a: BlockRange, b: BlockRange): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** STRING is Latin-1: code points past U+00FF become "?". */
function latin1(text: string): Buffer {
  const out: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    out.push(codePoint <= 0xff ? codePoint : 0x3f);
  }
  return Buffer.from(out);
}

/**
 * The XTEST events of one input call: each is sent without its own round trip, a sync barrier
 * follows every {@link SYNC_EVERY}, and `flush()` reports the first X error among them. It
 * remembers what is pressed so the call can release it when it fails. Once `signal` aborts, every
 * press and motion throws its reason; releases still go out.
 */
class InputBatch {
  /** Keys and buttons pressed and not yet released, in press order. */
  readonly pressed: Array<{ kind: "key" | "button"; code: number }> = [];
  private sent = 0;
  private posts: Promise<void>[] = [];

  constructor(
    private readonly conn: X11Connection,
    private readonly xtest: number,
    private readonly root: number,
    private readonly signal?: AbortSignal
  ) {}

  key(keycode: number, down: boolean): Promise<void> {
    if (down) this.signal?.throwIfAborted();
    this.track("key", keycode, down);
    return this.fake({ type: down ? FakeEventType.KeyPress : FakeEventType.KeyRelease, detail: keycode });
  }

  button(button: number, down: boolean): Promise<void> {
    if (down) this.signal?.throwIfAborted();
    this.track("button", button, down);
    return this.fake({ type: down ? FakeEventType.ButtonPress : FakeEventType.ButtonRelease, detail: button });
  }

  motion(x: number, y: number): Promise<void> {
    this.signal?.throwIfAborted();
    return this.fake({ type: FakeEventType.MotionNotify, detail: 0, root: this.root, x, y });
  }

  /** Forget a press the call means to leave held (mouse_down). */
  keep(kind: "key" | "button", code: number): void {
    this.track(kind, code, false);
  }

  /** Release everything still pressed, last pressed first. */
  async releaseAll(): Promise<void> {
    for (const { kind, code } of [...this.pressed].reverse()) {
      if (kind === "key") await this.key(code, false);
      else await this.button(code, false);
    }
  }

  /** A sync barrier; throws the first error any event since the last one caused. */
  async flush(): Promise<void> {
    const posts = this.posts;
    this.posts = [];
    await this.conn.sync();
    for (const result of await Promise.allSettled(posts)) if (result.status === "rejected") throw result.reason;
  }

  private track(kind: "key" | "button", code: number, down: boolean): void {
    if (down) {
      this.pressed.push({ kind, code });
      return;
    }
    for (let at = this.pressed.length - 1; at >= 0; at--) {
      if (this.pressed[at]!.kind !== kind || this.pressed[at]!.code !== code) continue;
      this.pressed.splice(at, 1);
      return;
    }
  }

  private async fake(input: FakeInput): Promise<void> {
    const posted = this.conn.post(encodeXTestFakeInput(this.xtest, input));
    // Observed by flush(); never an unhandled rejection meanwhile.
    posted.catch(() => {});
    this.posts.push(posted);
    if (++this.sent % SYNC_EVERY === 0) await this.flush();
  }
}

class X11DesktopAutomation implements DesktopAutomation {
  private display: DesktopSize;
  private sequence = 0;
  private gridColumns = 0;
  private gridRows = 0;
  /** Per 16×16 block: when it last changed (`Date.now()`), and the screen sequence then. */
  private blockTime = new Float64Array(0);
  private blockSeq = new Float64Array(0);
  private subtractQueued = false;
  private readonly waiters = new Set<Waiter>();
  private readonly resizeListeners = new Set<(size: DesktopSize) => void>();
  private converter: PixelConverter | null = null;

  private keyboardCache: Keyboard | null = null;
  /** Bumped on every MappingNotify: a mapping read before it is stale. */
  private mappingGeneration = 0;
  /** Keysym → the spare keycode it is bound to, least recently used first. */
  private readonly bindings = new Map<number, number>();
  /** Buttons left down by `button(b, true)`. */
  private readonly heldButtons = new Set<number>();

  private clipboard: OwnedClipboard | null = null;
  private readonly timestampWaiters: Array<(time: number) => void> = [];
  private selectionWaiter: { notify(event: Extract<XEvent, { type: "SelectionNotify" }>): void; fail(error: Error): void } | null = null;

  private chain: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private dropped = false;
  private damage = 0;
  private helper = 0;

  private constructor(
    private readonly conn: X11Connection,
    private readonly xtest: number,
    private readonly damageExtension: { majorOpcode: number; firstEvent: number },
    private readonly atoms: Atoms
  ) {
    const screen = conn.setup.screens[0]!;
    this.display = { width: screen.width, height: screen.height };
    conn.on("event", (event) => this.onEvent(event));
    conn.on("close", () => this.onDropped());
  }

  /** Negotiate the extensions, create the helper window and the damage, and read the screen size. */
  static async open(conn: X11Connection): Promise<X11DesktopAutomation> {
    const [xtest, damage, xfixes] = await Promise.all([
      conn.queryExtension(XTEST_EXTENSION_NAME),
      conn.queryExtension(DAMAGE_EXTENSION_NAME),
      conn.queryExtension(XFIXES_EXTENSION_NAME)
    ]);
    if (!xtest.present) throw new Error("The X server has no XTEST extension, so input cannot be sent to the desktop.");
    if (!damage.present || !xfixes.present) throw new Error("The X server has no DAMAGE/XFIXES extension, so screen changes cannot be followed.");
    await conn.request(encodeXTestGetVersion(xtest.majorOpcode));
    // DAMAGE needs the client's XFIXES version first.
    await conn.request(encodeXFixesQueryVersion(xfixes.majorOpcode));
    await conn.request(encodeDamageQueryVersion(damage.majorOpcode));
    const atomValues = await Promise.all(ATOM_NAMES.map((name) => conn.internAtom(name)));
    const atoms = Object.fromEntries(ATOM_NAMES.map((name, i) => [name, atomValues[i]!])) as Atoms;
    // Listening (events, close) starts before the damage exists, so no notification is missed.
    const engine = new X11DesktopAutomation(conn, xtest.majorOpcode, damage, atoms);
    await engine.initialize();
    return engine;
  }

  private async initialize(): Promise<void> {
    const { conn } = this;
    this.helper = conn.allocateId();
    await conn.requestVoid(encodeCreateWindow(this.helper, conn.root, { x: -1, y: -1, width: 1, height: 1 }, WindowClass.InputOnly, { eventMask: EventMask.PropertyChange }));
    await conn.selectInput(conn.root, EventMask.StructureNotify);
    const geometry = await conn.getGeometry(conn.root);
    this.display = { width: geometry.width, height: geometry.height };
    this.resetGrid();
    this.damage = conn.allocateId();
    await conn.requestVoid(encodeDamageCreate(this.damageExtension.majorOpcode, this.damage, conn.root, DamageReportLevel.RawRectangles));
  }

  get closed(): boolean {
    return this.dropped || this.closing !== null;
  }

  size(): DesktopSize {
    return { ...this.display };
  }

  seq(): number {
    return this.sequence;
  }

  onResize(listener: (size: DesktopSize) => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  async pointer(): Promise<{ x: number; y: number }> {
    this.assertOpen();
    try {
      const reply = await this.conn.queryPointer(this.conn.root);
      return { x: reply.rootX, y: reply.rootY };
    } catch (error) {
      throw notRunning(error);
    }
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  async capture(region?: DesktopRect): Promise<DesktopCapture> {
    this.assertOpen();
    this.converter ??= pixelConverter(this.conn.setup);
    const rect = this.clip(region ?? { x: 0, y: 0, ...this.display });
    const seq = this.sequence;
    const display = this.size();
    const stride = rect.width * 4;
    const rgb = Buffer.allocUnsafe(rect.width * rect.height * 3);
    const bandRows = Math.max(1, Math.floor(CAPTURE_BAND_BYTES / stride));
    const depth = this.conn.setup.screens[0]!.rootDepth;
    try {
      for (let row = 0; row < rect.height; row += bandRows) {
        const rows = Math.min(bandRows, rect.height - row);
        const reply = await this.conn.getImage(this.conn.root, { x: rect.x, y: rect.y + row, width: rect.width, height: rows });
        if (reply.depth !== depth || reply.data.length < rows * stride) throw new Error(`GetImage answered depth ${reply.depth} with ${reply.data.length} bytes for ${rect.width}×${rows}`);
        this.converter(reply.data, rgb, row * rect.width * 3, rows * rect.width);
      }
      const pointer = await this.conn.queryPointer(this.conn.root);
      return { width: rect.width, height: rect.height, origin: { x: rect.x, y: rect.y }, rgb, seq, display, cursor: { x: pointer.rootX, y: pointer.rootY } };
    } catch (error) {
      throw notRunning(error);
    }
  }

  // -------------------------------------------------------------------------
  // Damage and waits
  // -------------------------------------------------------------------------

  async wait(options: DesktopWaitOptions): Promise<DesktopWaitResult> {
    this.assertOpen();
    const { signal } = options;
    signal?.throwIfAborted();
    if (options.for !== "idle" && options.for !== "change") throw new DesktopAutomationError("INVALID_ARGUMENT", `Unknown wait "${String(options.for)}"`);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new DesktopAutomationError("INVALID_ARGUMENT", "timeoutMs must be a non-negative number");
    if (options.for === "idle" && (!Number.isFinite(options.idleMs) || options.idleMs < 0)) throw new DesktopAutomationError("INVALID_ARGUMENT", "idleMs must be a non-negative number");
    if (options.since !== undefined && !Number.isFinite(options.since)) throw new DesktopAutomationError("INVALID_ARGUMENT", "since must be a screen sequence");
    if (options.notBefore !== undefined && !Number.isFinite(options.notBefore)) throw new DesktopAutomationError("INVALID_ARGUMENT", "notBefore must be a time");
    const region = options.region ? this.clip(options.region) : null;
    const start = Date.now();
    const deadline = start + options.timeoutMs;
    return new Promise<DesktopWaitResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let changed = false;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (timedOut: boolean): void => {
        done();
        resolve({ changed, timedOut, seq: this.sequence, waitedMs: Date.now() - start });
      };
      const onAbort = (): void => {
        done();
        reject(signal!.reason);
      };
      const waiter: Waiter = {
        region,
        changed: () => {},
        fail: (error) => {
          done();
          reject(error);
        }
      };
      if (options.for === "change") {
        const since = options.since ?? this.sequence;
        waiter.changed = (seq) => {
          if (seq <= since) return;
          changed = true;
          finish(false);
        };
        if (this.regionSeq(region) > since) {
          changed = true;
          finish(false);
          return;
        }
        timer = setTimeout(() => finish(true), options.timeoutMs);
      } else {
        // Damage only marks the wait as changed; the one timer re-checks the region's last change
        // when the idle period (or the timeout) would be over, and re-arms if it moved. Stillness
        // before `notBefore` (default: now) does not count.
        waiter.changed = () => {
          changed = true;
        };
        const notBefore = options.notBefore ?? start;
        const check = (): void => {
          timer = null;
          const now = Date.now();
          const idleAt = Math.max(this.regionTime(region), notBefore) + options.idleMs;
          if (idleAt <= now) return finish(false);
          if (deadline <= now) return finish(true);
          timer = setTimeout(check, Math.min(idleAt, deadline) - now);
        };
        check();
        if (timer === null) return;
      }
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private resetGrid(): void {
    this.gridColumns = Math.ceil(this.display.width / BLOCK);
    this.gridRows = Math.ceil(this.display.height / BLOCK);
    this.blockTime = new Float64Array(this.gridColumns * this.gridRows).fill(Date.now());
    this.blockSeq = new Float64Array(this.gridColumns * this.gridRows).fill(this.sequence);
  }

  /** The grid blocks a rectangle covers (clipped to the screen), as column/row ranges. */
  private blocks(rect: DamageRect | null): BlockRange {
    if (!rect) return { x0: 0, x1: this.gridColumns, y0: 0, y1: this.gridRows };
    return {
      x0: Math.max(0, Math.floor(rect.x / BLOCK)),
      x1: Math.min(this.gridColumns, Math.ceil((rect.x + rect.width) / BLOCK)),
      y0: Math.max(0, Math.floor(rect.y / BLOCK)),
      y1: Math.min(this.gridRows, Math.ceil((rect.y + rect.height) / BLOCK))
    };
  }

  /** When the region last changed. */
  private regionTime(region: DesktopRect | null): number {
    const { x0, x1, y0, y1 } = this.blocks(region);
    let latest = -Infinity;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) latest = Math.max(latest, this.blockTime[y * this.gridColumns + x]!);
    return latest;
  }

  /** The screen sequence of the region's last change. */
  private regionSeq(region: DesktopRect | null): number {
    const { x0, x1, y0, y1 } = this.blocks(region);
    let latest = -Infinity;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) latest = Math.max(latest, this.blockSeq[y * this.gridColumns + x]!);
    return latest;
  }

  private onDamage(area: DamageRect): void {
    this.sequence += 1;
    const now = Date.now();
    const damaged = this.blocks(area);
    for (let y = damaged.y0; y < damaged.y1; y++) {
      for (let x = damaged.x0; x < damaged.x1; x++) {
        this.blockTime[y * this.gridColumns + x] = now;
        this.blockSeq[y * this.gridColumns + x] = this.sequence;
      }
    }
    // By blocks, as the grid the waits start from records it: a region sees damage in any 16×16
    // block it touches, so a live wait and one answered from the grid agree at the region's edges.
    for (const waiter of [...this.waiters]) if (!waiter.region || overlaps(this.blocks(waiter.region), damaged)) waiter.changed(this.sequence);
    // One DamageSubtract per batch of notifications keeps the server's damage region small.
    if (this.subtractQueued) return;
    this.subtractQueued = true;
    setImmediate(() => {
      this.subtractQueued = false;
      if (this.closed) return;
      this.conn.requestVoid(encodeDamageSubtract(this.damageExtension.majorOpcode, this.damage)).catch(() => {});
    });
  }

  private onRootResize(size: DesktopSize): void {
    if (size.width === this.display.width && size.height === this.display.height) return;
    this.display = size;
    this.sequence += 1;
    this.resetGrid();
    for (const waiter of [...this.waiters]) waiter.changed(this.sequence);
    for (const listener of [...this.resizeListeners]) listener(this.size());
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  async move(x: number, y: number, signal?: AbortSignal): Promise<void> {
    const point = this.point(x, y);
    return this.input((io) => io.motion(point.x, point.y), signal);
  }

  async button(button: XButton, down: boolean, signal?: AbortSignal): Promise<void> {
    this.assertButton(button);
    return this.input(async (io) => {
      await io.button(button, down);
      if (down) {
        // Left down on purpose (mouse_down): released by a later button(b, false) or on close.
        io.keep("button", button);
        this.heldButtons.add(button);
      } else {
        this.heldButtons.delete(button);
      }
    }, signal);
  }

  async click(x: number, y: number, button: XButton, count: number, modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void> {
    const point = this.point(x, y);
    this.assertButton(button);
    if (!Number.isInteger(count) || count < 1 || count > 3) throw new DesktopAutomationError("INVALID_ARGUMENT", "count must be 1–3");
    return this.input(async (io) => {
      await io.motion(point.x, point.y);
      const held = await this.pressModifiers(io, modifiers);
      for (let i = 0; i < count; i++) {
        if (i > 0) {
          await io.flush();
          await delay(CLICK_INTERVAL_MS);
        }
        await io.button(button, true);
        await io.button(button, false);
      }
      await this.releaseKeys(io, held);
    }, signal);
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, button: XButton, modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void> {
    const start = this.point(from.x, from.y);
    const end = this.point(to.x, to.y);
    this.assertButton(button);
    return this.input(async (io) => {
      await io.motion(start.x, start.y);
      const held = await this.pressModifiers(io, modifiers);
      await io.button(button, true);
      for (let step = 1; step <= DRAG_STEPS; step++) {
        await io.flush();
        await delay(DRAG_STEP_MS);
        await io.motion(Math.round(start.x + ((end.x - start.x) * step) / DRAG_STEPS), Math.round(start.y + ((end.y - start.y) * step) / DRAG_STEPS));
      }
      await io.button(button, false);
      await this.releaseKeys(io, held);
    }, signal);
  }

  async scroll(
    at: { x: number; y: number } | null,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    modifiers: readonly DesktopModifier[],
    signal?: AbortSignal
  ): Promise<void> {
    const point = at ? this.point(at.x, at.y) : null;
    const wheel = { up: 4, down: 5, left: 6, right: 7 }[direction];
    if (wheel === undefined) throw new DesktopAutomationError("INVALID_ARGUMENT", `Unknown scroll direction "${String(direction)}"`);
    if (!Number.isInteger(amount) || amount < 1 || amount > 50) throw new DesktopAutomationError("INVALID_ARGUMENT", "amount must be 1–50");
    return this.input(async (io) => {
      if (point) await io.motion(point.x, point.y);
      const held = await this.pressModifiers(io, modifiers);
      for (let i = 0; i < amount; i++) {
        await io.button(wheel, true);
        await io.button(wheel, false);
      }
      await this.releaseKeys(io, held);
    }, signal);
  }

  async key(combo: string, repeat: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new DesktopAutomationError("INVALID_ARGUMENT", "repeat must be 1–20");
    const keys = parseCombo(combo);
    return this.input(async (io) => {
      const resolved: Array<{ keycode: number; shift: boolean }> = [];
      for (const key of keys) resolved.push(await this.comboKeycode(io, key));
      // A key only reachable shifted gets Shift around it, unless the combo holds Shift already.
      const comboShift = keys.some((key) => (key.kind === "modifier" ? key.modifier === "shift" : MODIFIER_KEYSYMS.shift.includes(key.keysym)));
      const shift = resolved.some((key) => key.shift) && !comboShift ? this.modifierKeycode(await this.keyboard(), "shift") : null;
      for (let i = 0; i < repeat; i++) {
        const pressed: number[] = [];
        for (const key of resolved) {
          if (key.shift && shift !== null) {
            await io.key(shift, true);
            pressed.push(shift);
          }
          await io.key(key.keycode, true);
          pressed.push(key.keycode);
        }
        await this.releaseKeys(io, pressed);
      }
    }, signal);
  }

  async type(text: string, signal?: AbortSignal): Promise<void> {
    if ([...text].length > DESKTOP_TYPE_MAX_CHARS) throw new DesktopAutomationError("INVALID_ARGUMENT", `The text is longer than ${DESKTOP_TYPE_MAX_CHARS} characters`);
    const keysyms = keysymsForText(text);
    return this.input(async (io) => {
      for (const keysym of keysyms) {
        // close() lets a long text stop between characters (and so does the signal: io's presses check it).
        this.assertOpen();
        const { keycode, shift } = await this.keycodeFor(io, keysym);
        const shiftKey = shift ? this.modifierKeycode(await this.keyboard(), "shift") : null;
        if (shiftKey !== null) await io.key(shiftKey, true);
        await io.key(keycode, true);
        await io.key(keycode, false);
        if (shiftKey !== null) await io.key(shiftKey, false);
      }
    }, signal);
  }

  /**
   * Run one input call alone, ending with a sync barrier. Whatever it pressed and did not release
   * (it failed halfway, or `signal` aborted it) is released first; its own error wins over one
   * from that clean-up. A call whose signal aborted while it waited its turn never starts.
   */
  private input(job: (io: InputBatch) => Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    return this.exclusive(async () => {
      this.assertOpen();
      signal?.throwIfAborted();
      const io = new InputBatch(this.conn, this.xtest, this.conn.root, signal);
      let failure: unknown = null;
      try {
        await job(io);
      } catch (error) {
        failure = error;
      }
      try {
        await io.releaseAll();
        await io.flush();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== null) throw notRunning(failure);
    });
  }

  private async pressModifiers(io: InputBatch, modifiers: readonly DesktopModifier[]): Promise<number[]> {
    const pressed: number[] = [];
    if (modifiers.length === 0) return pressed;
    const keyboard = await this.keyboard();
    const keycodes = modifiers.map((modifier) => this.modifierKeycode(keyboard, modifier));
    for (const keycode of keycodes) {
      await io.key(keycode, true);
      pressed.push(keycode);
    }
    return pressed;
  }

  /** Release keys in reverse press order. */
  private async releaseKeys(io: InputBatch, pressed: readonly number[]): Promise<void> {
    for (const keycode of [...pressed].reverse()) await io.key(keycode, false);
  }

  private comboKeycode(io: InputBatch, key: ComboKey): Promise<{ keycode: number; shift: boolean }> {
    if (key.kind === "keysym") return this.keycodeFor(io, key.keysym);
    return this.keyboard().then((keyboard) => ({ keycode: this.modifierKeycode(keyboard, key.modifier), shift: false }));
  }

  /** The keyboard and modifier mappings, read once and again after a MappingNotify. */
  private async keyboard(): Promise<Keyboard> {
    if (this.keyboardCache) return this.keyboardCache;
    const generation = this.mappingGeneration;
    const [mapping, modifiers] = await Promise.all([this.conn.getKeyboardMapping(), this.conn.getModifierMapping()]);
    const keyboard: Keyboard = { minKeycode: this.conn.setup.minKeycode, maxKeycode: this.conn.setup.maxKeycode, mapping, modifiers };
    // A binding someone else has since replaced is no longer ours to restore.
    for (const [keysym, keycode] of this.bindings) if (this.keysymsOf(keyboard, keycode)[0] !== keysym) this.bindings.delete(keysym);
    if (generation === this.mappingGeneration) this.keyboardCache = keyboard;
    return keyboard;
  }

  private keysymsOf(keyboard: Keyboard, keycode: number): Uint32Array {
    const { keysymsPerKeycode, keysyms } = keyboard.mapping;
    const at = (keycode - keyboard.minKeycode) * keysymsPerKeycode;
    return keysyms.subarray(at, at + keysymsPerKeycode);
  }

  /** The keycode producing `keysym` unshifted, else shifted (group 1 only), or null. */
  private findKeycode(keyboard: Keyboard, keysym: number): { keycode: number; shift: boolean } | null {
    for (const shift of [false, true]) {
      for (let keycode = keyboard.minKeycode; keycode <= keyboard.maxKeycode; keycode++) {
        const syms = this.keysymsOf(keyboard, keycode);
        let first = syms[0] ?? 0;
        let second = syms[1] ?? 0;
        // Core rule: a letter listed alone is lower case unshifted and upper case shifted; any other
        // keysym listed alone is the same at both levels.
        if (second === 0) {
          const cases = letterCases(first);
          if (cases) [first, second] = [cases.lower, cases.upper];
          else second = first;
        }
        if ((shift ? second : first) === keysym && keysym !== 0) return { keycode, shift };
      }
    }
    return null;
  }

  /** A modifier's key: one in the modifier map carrying the modifier's keysym, else any key with it. */
  private modifierKeycode(keyboard: Keyboard, modifier: DesktopModifier): number {
    const wanted = MODIFIER_KEYSYMS[modifier];
    for (const row of keyboard.modifiers) {
      for (const keycode of row) if ([...this.keysymsOf(keyboard, keycode)].some((keysym) => wanted.includes(keysym))) return keycode;
    }
    for (const keysym of wanted) {
      const found = this.findKeycode(keyboard, keysym);
      if (found && !found.shift) return found.keycode;
    }
    throw new DesktopAutomationError("INVALID_ARGUMENT", `The desktop's keyboard has no ${modifier} key`);
  }

  /**
   * The keycode for a keysym. One the keymap lacks is bound to a spare keycode (one with no
   * keysyms); the binding stays in a small LRU so the clients reading the key events see it, and
   * is restored when evicted or when the engine closes.
   */
  private async keycodeFor(io: InputBatch, keysym: number): Promise<{ keycode: number; shift: boolean }> {
    const keyboard = await this.keyboard();
    const found = this.findKeycode(keyboard, keysym);
    const bound = this.bindings.get(keysym);
    if (found) {
      if (bound !== undefined) {
        this.bindings.delete(keysym);
        this.bindings.set(keysym, bound);
      }
      return found;
    }
    let keycode: number | undefined;
    if (this.bindings.size >= TEMP_BINDINGS) {
      const [evicted, reused] = this.bindings.entries().next().value!;
      this.bindings.delete(evicted);
      keycode = reused;
      // The call may have just pressed the evicted keysym: let the server take those events first.
      await io.flush();
    } else {
      const taken = new Set(this.bindings.values());
      for (let candidate = keyboard.maxKeycode; candidate >= keyboard.minKeycode && keycode === undefined; candidate--) {
        if (!taken.has(candidate) && this.keysymsOf(keyboard, candidate).every((sym) => sym === 0)) keycode = candidate;
      }
    }
    if (keycode === undefined) throw new DesktopAutomationError("INVALID_ARGUMENT", `No spare keycode to type keysym 0x${keysym.toString(16)}`);
    await this.conn.requestVoid(encodeChangeKeyboardMapping(keycode, 2, [keysym, keysym]));
    this.bindings.set(keysym, keycode);
    // Our own MappingNotify follows; until then the cache would not know the new binding.
    this.keyboardCache = null;
    return { keycode, shift: false };
  }

  private point(x: number, y: number): { x: number; y: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new DesktopAutomationError("INVALID_ARGUMENT", "Coordinates must be numbers");
    const point = { x: Math.round(x), y: Math.round(y) };
    if (point.x < 0 || point.y < 0 || point.x >= this.display.width || point.y >= this.display.height) {
      throw new DesktopAutomationError("INVALID_ARGUMENT", `(${point.x}, ${point.y}) is outside the ${this.display.width}×${this.display.height} display`);
    }
    return point;
  }

  private assertButton(button: number): void {
    if (!Number.isInteger(button) || button < 1 || button > 7) throw new DesktopAutomationError("INVALID_ARGUMENT", "button must be 1–7");
  }

  // -------------------------------------------------------------------------
  // Clipboard
  // -------------------------------------------------------------------------

  async setClipboard(text: string, signal?: AbortSignal): Promise<void> {
    const utf8 = Buffer.from(text, "utf8");
    if (utf8.length > DESKTOP_CLIPBOARD_MAX_BYTES) throw new DesktopAutomationError("INVALID_ARGUMENT", `The clipboard text is larger than ${DESKTOP_CLIPBOARD_MAX_BYTES} bytes`);
    this.assertOpen();
    signal?.throwIfAborted();
    return this.exclusive(async () => {
      this.assertOpen();
      signal?.throwIfAborted();
      try {
        const time = await this.serverTime();
        // Set before the request: a SelectionRequest may follow it at once.
        this.clipboard = { text, utf8, time };
        await this.conn.requestVoid(encodeSetSelectionOwner(this.helper, this.atoms.CLIPBOARD, time));
        if ((await this.conn.getSelectionOwner(this.atoms.CLIPBOARD)) !== this.helper) {
          this.clipboard = null;
          throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", "Another client kept the clipboard.");
        }
      } catch (error) {
        throw notRunning(error);
      }
    });
  }

  async getClipboard(): Promise<string> {
    this.assertOpen();
    return this.exclusive(async () => {
      this.assertOpen();
      try {
        return await this.readClipboard();
      } catch (error) {
        throw notRunning(error);
      }
    });
  }

  private async readClipboard(): Promise<string> {
    const { conn, atoms } = this;
    const owner = await conn.getSelectionOwner(atoms.CLIPBOARD);
    if (owner === None) return "";
    if (owner === this.helper && this.clipboard) return this.clipboard.text;
    for (const target of [atoms.UTF8_STRING, PredefinedAtom.STRING]) {
      await conn.requestVoid(encodeDeleteProperty(this.helper, atoms._ORQUESTER_SELECTION));
      const notify = await this.convertSelection(target);
      if (notify.property === None) continue;
      const property = await conn.getProperty(this.helper, atoms._ORQUESTER_SELECTION, AnyPropertyType, DESKTOP_CLIPBOARD_MAX_BYTES + 1);
      if (!property) throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", "The clipboard owner answered without the text.");
      // An INCR transfer is left unstarted (the property is not deleted); the next read deletes it.
      if (property.type === atoms.INCR) throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", "The clipboard holds a large incremental (INCR) transfer, which is not supported.");
      await conn.requestVoid(encodeDeleteProperty(this.helper, atoms._ORQUESTER_SELECTION));
      if (property.value.length > DESKTOP_CLIPBOARD_MAX_BYTES) throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", `The clipboard holds more than ${DESKTOP_CLIPBOARD_MAX_BYTES} bytes.`);
      if (property.format !== 8) throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", "The clipboard does not hold text.");
      return property.value.toString(property.type === PredefinedAtom.STRING ? "latin1" : "utf8");
    }
    throw new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", "The clipboard does not hold text.");
  }

  /** ConvertSelection(CLIPBOARD) into the helper window's property, waiting ≤ 2 s for the owner's SelectionNotify. */
  private async convertSelection(target: number): Promise<Extract<XEvent, { type: "SelectionNotify" }>> {
    const time = await this.serverTime();
    return new Promise((resolve, reject) => {
      const fail = (error: unknown): void => {
        clearTimeout(timer);
        this.selectionWaiter = null;
        reject(error);
      };
      const timer = setTimeout(() => fail(new DesktopAutomationError("CLIPBOARD_UNAVAILABLE", `The clipboard owner did not answer within ${CLIPBOARD_TIMEOUT_MS / 1000} s.`)), CLIPBOARD_TIMEOUT_MS);
      this.selectionWaiter = {
        notify: (event) => {
          // The request's own timestamp tells its answer from a late one to an earlier request.
          if (event.requestor !== this.helper || event.selection !== this.atoms.CLIPBOARD || event.target !== target || event.time !== time) return;
          clearTimeout(timer);
          this.selectionWaiter = null;
          resolve(event);
        },
        fail
      };
      this.conn.requestVoid(encodeConvertSelection(this.helper, this.atoms.CLIPBOARD, target, this.atoms._ORQUESTER_SELECTION, time)).catch(fail);
    });
  }

  /** The server's current time: a zero-length append to the helper's property, read from its PropertyNotify (ICCCM §2.1). */
  private serverTime(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.timestampWaiters.push(resolve);
      this.conn
        .requestVoid(encodeChangeProperty(PropertyMode.Append, this.helper, this.atoms._ORQUESTER_TIMESTAMP, PredefinedAtom.STRING, 8, Buffer.alloc(0)))
        .catch((error: unknown) => {
          const at = this.timestampWaiters.indexOf(resolve);
          if (at >= 0) this.timestampWaiters.splice(at, 1);
          reject(error);
        });
    });
  }

  /** Answer a SelectionRequest for the clipboard we own (TARGETS, UTF8_STRING, STRING, TEXT); refuse anything else. */
  private async answerSelectionRequest(event: Extract<XEvent, { type: "SelectionRequest" }>): Promise<void> {
    const { atoms } = this;
    const clipboard = this.clipboard;
    // Obsolete clients name no property: the target doubles as one.
    const property = event.property === None ? event.target : event.property;
    let answered = false;
    if (clipboard && event.owner === this.helper && event.selection === atoms.CLIPBOARD) {
      try {
        if (event.target === atoms.TARGETS) {
          const targets = Buffer.alloc(16);
          [atoms.TARGETS, atoms.UTF8_STRING, PredefinedAtom.STRING, atoms.TEXT].forEach((atom, i) => targets.writeUInt32LE(atom, i * 4));
          await this.writeProperty(event.requestor, property, PredefinedAtom.ATOM, 32, targets);
          answered = true;
        } else if (event.target === atoms.UTF8_STRING || event.target === atoms.TEXT) {
          await this.writeProperty(event.requestor, property, atoms.UTF8_STRING, 8, clipboard.utf8);
          answered = true;
        } else if (event.target === PredefinedAtom.STRING) {
          await this.writeProperty(event.requestor, property, PredefinedAtom.STRING, 8, latin1(clipboard.text));
          answered = true;
        }
      } catch {
        // The requestor's window went away (or the connection): the answer below says no.
      }
    }
    const notify = encodeSelectionNotify(event.time, event.requestor, event.selection, event.target, answered ? property : None);
    await this.conn.requestVoid(encodeSendEvent(false, event.requestor, 0, notify)).catch(() => {});
  }

  /** ChangeProperty in pieces that fit the server's request length: the first replaces, the rest append. */
  private async writeProperty(window: number, property: number, type: number, format: 8 | 32, data: Buffer): Promise<void> {
    // 24 bytes of ChangeProperty header; the piece stays a whole number of 4-byte units.
    const pieceBytes = Math.max(4, (this.conn.setup.maximumRequestLength * 4 - 24) & ~3);
    const posts: Promise<void>[] = [];
    let offset = 0;
    do {
      const piece = data.subarray(offset, offset + pieceBytes);
      const posted = this.conn.post(encodeChangeProperty(offset === 0 ? PropertyMode.Replace : PropertyMode.Append, window, property, type, format, piece));
      posted.catch(() => {});
      posts.push(posted);
      offset += piece.length;
    } while (offset < data.length);
    await this.conn.sync();
    await Promise.all(posts);
  }

  // -------------------------------------------------------------------------
  // Events, lifecycle
  // -------------------------------------------------------------------------

  private onEvent(event: XEvent): void {
    switch (event.type) {
      case "other":
        if (event.code === this.damageExtension.firstEvent + DAMAGE_NOTIFY && this.damage !== 0) {
          const notify = decodeDamageNotify(event.data);
          if (notify.damage === this.damage) this.onDamage(notify.area);
        }
        return;
      case "ConfigureNotify":
        if (event.window === this.conn.root) this.onRootResize({ width: event.width, height: event.height });
        return;
      case "MappingNotify":
        if (event.request === MappingRequest.Keyboard || event.request === MappingRequest.Modifier) {
          this.mappingGeneration += 1;
          this.keyboardCache = null;
        }
        return;
      case "PropertyNotify":
        if (event.window === this.helper && event.atom === this.atoms._ORQUESTER_TIMESTAMP) this.timestampWaiters.shift()?.(event.time);
        return;
      case "SelectionRequest":
        void this.answerSelectionRequest(event);
        return;
      case "SelectionClear":
        // A clear older than our latest acquisition is about an earlier ownership.
        if (event.owner === this.helper && event.selection === this.atoms.CLIPBOARD && this.clipboard && event.time >= this.clipboard.time) this.clipboard = null;
        return;
      case "SelectionNotify":
        this.selectionWaiter?.notify(event);
        return;
      default:
        return;
    }
  }

  private onDropped(): void {
    this.dropped = true;
    const error = new DesktopAutomationError("DESKTOP_NOT_RUNNING", "The desktop's X connection closed.");
    for (const waiter of [...this.waiters]) waiter.fail(error);
    this.selectionWaiter?.fail(error);
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  /** After the running call: release held buttons, restore bound keycodes, give up the clipboard, then close. */
  private async shutdown(): Promise<void> {
    const error = new DesktopAutomationError("DESKTOP_NOT_RUNNING", "The desktop automation closed.");
    for (const waiter of [...this.waiters]) waiter.fail(error);
    if (!this.dropped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanUp = this.exclusive(() => this.releaseAll()).catch(() => {});
      const giveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        timer.unref?.();
      });
      await Promise.race([cleanUp, giveUp]);
      clearTimeout(timer);
    }
    this.clipboard = null;
    this.conn.close();
  }

  private async releaseAll(): Promise<void> {
    const { conn } = this;
    const io = new InputBatch(conn, this.xtest, conn.root);
    for (const button of this.heldButtons) await io.button(button, false);
    this.heldButtons.clear();
    await io.flush().catch(() => {});
    if (this.bindings.size > 0) {
      // Fresh: restore only bindings that are still ours.
      this.keyboardCache = null;
      await this.keyboard().catch(() => null);
      const restores = [...this.bindings.values()].map((keycode) => conn.requestVoid(encodeChangeKeyboardMapping(keycode, 2, [0, 0])).catch(() => {}));
      this.bindings.clear();
      await Promise.all(restores);
    }
    const clipboard = this.clipboard;
    this.clipboard = null;
    // With our acquisition time the request does nothing if another client has taken it since.
    if (clipboard) await conn.requestVoid(encodeSetSelectionOwner(None, this.atoms.CLIPBOARD, clipboard.time)).catch(() => {});
    await conn.requestVoid(encodeDamageDestroy(this.damageExtension.majorOpcode, this.damage)).catch(() => {});
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new DesktopAutomationError("DESKTOP_NOT_RUNNING", this.dropped ? "The desktop's X connection closed." : "The desktop automation closed.");
  }

  /** A rectangle clipped to the display; INVALID_ARGUMENT when nothing of it is on screen. */
  private clip(rect: DesktopRect): DesktopRect {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new DesktopAutomationError("INVALID_ARGUMENT", "The region must be numbers");
    const x0 = Math.max(0, Math.round(rect.x));
    const y0 = Math.max(0, Math.round(rect.y));
    const x1 = Math.min(this.display.width, Math.round(rect.x + rect.width));
    const y1 = Math.min(this.display.height, Math.round(rect.y + rect.height));
    if (x1 <= x0 || y1 <= y0) throw new DesktopAutomationError("INVALID_ARGUMENT", `The region is outside the ${this.display.width}×${this.display.height} display`);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
}
