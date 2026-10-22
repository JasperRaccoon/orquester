/**
 * The VM browser: the Browser tab of a project on a LINUX box runs its
 * Chromium inside the box, so the page's `localhost` is the box's and its dev
 * servers need no host forward. Screencast, input, viewports and the picker
 * are `BrowserManager`'s, unchanged: this module only supplies the project's
 * {@link BrowserChrome} (`BrowserManager.setRemoteChrome`). macOS and Windows
 * boxes keep the host Chromium and its dev forwards
 * (`remote/exec/dev-forwards.ts`), and so does every box while no installer
 * is wired.
 *
 * A launch:
 *
 * 1. Chromium in the box comes from the GUI installer (`ensureBrowser`, once
 *    per box), injected as {@link BoxBrowserInstaller}.
 * 2. A detached process (`orq-browser-<project hash>-<n>`) runs it headless
 *    with `--remote-debugging-port=0` and a stable per-project profile under
 *    `orq-agent`'s data dir. The port comes from Chromium's own
 *    `DevTools listening on ws://…` stderr line, within a deadline.
 * 3. A host loopback forward (`forwardToHost`) reaches that port; puppeteer
 *    connects through it over a socket whose messages are size-capped, so a
 *    box cannot make the daemon buffer without bound.
 * 4. Sandboxing as on the host: sandboxed first, one `--no-sandbox` retry on a
 *    sandbox failure (only once the first process is known to have ended),
 *    and `sandboxed: false` reported honestly (directly when the installer
 *    says the box cannot sandbox, e.g. running as root).
 *
 * Trust: the box controls what its Chromium serves and says. Nothing it
 * serves reaches the daemon's origin — `trustedDevtools: false` keeps the
 * DevTools frontend proxy (same-origin with the app and its credential) off
 * VM tabs; what does reach the client (frames, titles, URLs, pick payloads)
 * is data the UI renders as images and text.
 *
 * Lifetime — kill and relaunch, never reattach: the in-box Chromium lives
 * exactly as long as the host's `BrowserChrome` for it. Closing it (the
 * project's last tab, daemon shutdown, the box destroyed) ends the process
 * (CDP `Browser.close`, then SIGKILL), releases it and closes the forward; a
 * last tab closed mid-launch aborts the launch, which ends whatever it
 * started. A dropped link disconnects puppeteer at once, so `BrowserManager`
 * evicts the Chromium and the next subscribe relaunches. Whatever a dropped
 * link or a crashed daemon left running in the box is stopped when the box
 * (re)connects and before any launch of the same project (its profile lock
 * would otherwise hand the new Chromium off to the old one): every
 * `orq-browser-*` process this daemon does not own is a leftover.
 */

import { createHash, randomUUID } from "node:crypto";

import puppeteer, { type Browser, type ConnectionTransport } from "puppeteer-core";
import { WebSocket } from "ws";

import type { BoxDetachedProcInfo } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import { BrowserError, isRetryableSandboxFailure, type BrowserChrome, type RemoteChromeLauncher } from "../../../browsers.ts";
import type { BoxConnection, BoxHostForward, BoxHub, BoxProcess, BoxRegistry } from "../../contracts.ts";

/** What the GUI installer (`remote/gui`) hands back for a box. */
export interface BoxBrowserRuntime {
  chromiumPath: string;
  /** The box cannot sandbox Chromium (root, no user namespaces): launch with `--no-sandbox`. */
  noSandbox: boolean;
}

/**
 * The GUI installer's browser half (`BoxGuiInstaller.ensureBrowser`). Installs once per box;
 * an install that cannot happen throws an error with `code: "BOX_GUI_UNAVAILABLE"` and a `hint`.
 */
export interface BoxBrowserInstaller {
  ensureBrowser(
    connection: BoxConnection,
    options?: { signal?: AbortSignal; onProgress?: (line: string) => void }
  ): Promise<BoxBrowserRuntime>;
}

export interface BoxBrowsersDeps {
  registry: Pick<BoxRegistry, "locate" | "get" | "list" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** Without one, no tab runs in a box: box projects keep the host Chromium and dev forwards. */
  installer?: BoxBrowserInstaller;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Deadline for Chromium to announce its debugging endpoint. Default 30 s. */
  launchDeadlineMs?: number;
  /** Deadline for a stopping Chromium to exit before it is SIGKILLed (and again after). Default 5 s. */
  exitDeadlineMs?: number;
  /** Largest CDP message accepted from a box Chromium. Default {@link BOX_CDP_MAX_PAYLOAD}. */
  cdpMaxPayload?: number;
}

/** Every detached Chromium process this module starts has an id with this prefix. */
export const BOX_BROWSER_PROC_PREFIX = "orq-browser-";

/**
 * Largest CDP message from a box Chromium (puppeteer's own socket allows 256 MiB). Frames and
 * pick screenshots are a few MiB at most; a larger message closes the socket, which reads as the
 * browser going away.
 */
export const BOX_CDP_MAX_PAYLOAD = 32 * 1024 * 1024;

const DEFAULT_LAUNCH_DEADLINE_MS = 30_000;
const DEFAULT_EXIT_DEADLINE_MS = 5_000;
const CDP_HANDSHAKE_DEADLINE_MS = 10_000;
/** Chromium's stderr kept for a failed launch's message. */
const STDERR_TAIL_CHARS = 2_000;
/**
 * The box's output buffer for a Chromium process. Its stderr is read as it comes; the buffer
 * only absorbs bursts while the link is slow (a viewer that falls behind it ends with an error).
 */
const PROC_BUFFER_BYTES = 1024 * 1024;
const PROGRESS_MAX_CHARS = 200;

/** A project box whose Browser tab runs Chromium in the box: the Linux kinds. */
export function boxRunsBrowser(record: Pick<StoredBox, "kind">): boolean {
  return record.kind === "linux" || record.kind === "linux-gpu";
}

/** The stable per-project hash naming its profile dir and process ids (like the host's profiles). */
export function projectBrowserHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

/** Port and path of Chromium's `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>` line. */
export function parseDevtoolsListening(line: string): { port: number; path: string } | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
    if (!url.pathname.startsWith("/devtools/browser/")) return null;
    return { port, path: url.pathname };
  } catch {
    return null;
  }
}

/** The argv of a box Chromium (after the binary). */
export function boxChromiumArgs(profileDir: string, noSandbox: boolean): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--mute-audio",
    // Errors and fatals only (sandbox failures among them): less stderr to carry from the box.
    "--log-level=2",
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank"
  ];
}

/**
 * A CDP transport over `ws` with a message size cap and a handshake deadline (puppeteer's own
 * allows 256 MiB messages and waits on the handshake without one).
 */
export function connectBoundedTransport(url: string, maxPayload: number, handshakeTimeout = CDP_HANDSHAKE_DEADLINE_MS): Promise<ConnectionTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [], { perMessageDeflate: false, allowSynchronousEvents: false, maxPayload, handshakeTimeout, followRedirects: false });
    const transport: ConnectionTransport = {
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      },
      close: () => ws.close()
    };
    ws.on("message", (data: WebSocket.RawData) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      transport.onmessage?.(bytes.toString("utf8"));
    });
    ws.on("close", () => transport.onclose?.());
    ws.once("open", () => resolve(transport));
    // Before open: the connect fails. After: a close follows (an oversized message is a 1009).
    ws.on("error", (error) => reject(error));
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGuiUnavailable(error: unknown): error is Error & { hint?: string | null } {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "BOX_GUI_UNAVAILABLE";
}

function hasExited(proc: BoxProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Processes whose channel detached or failed: no exit will ever be reported on them. */
const unobservable = new WeakSet<BoxProcess>();

/** Mark `proc` unobservable once its channel detaches or fails; `onError` hears the failure. */
function observe(proc: BoxProcess, onError: (error: Error) => void): void {
  proc.on("detached", () => unobservable.add(proc));
  // Permanent: an unheard "error" event would take the daemon down.
  proc.on("error", (error) => {
    unobservable.add(proc);
    onError(error);
  });
  proc.stdin.on("error", () => undefined);
}

/** Resolves true once `proc` reports its exit; false at the deadline, or at once when it cannot report one. */
function waitExit(proc: BoxProcess, deadlineMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  if (unobservable.has(proc)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (exited: boolean): void => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("detached", onGone);
      proc.off("error", onGone);
      resolve(exited);
    };
    const onExit = (): void => done(true);
    const onGone = (): void => done(false);
    const timer = setTimeout(() => done(false), deadlineMs);
    proc.on("exit", onExit);
    proc.on("detached", onGone);
    proc.on("error", onGone);
  });
}

/** `promise`, or undefined once `ms` passed (a deadline on a call that may hang on a dead link). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function cancelled(): BrowserError {
  return new BrowserError("The browser launch was cancelled", 409);
}

/** `promise`, rejected as soon as `signal` aborts (the work itself may finish later, unused). */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** A start that failed; `ended` says whether its process is known to be gone (or never ran). */
class StartFailure extends Error {
  constructor(readonly reason: unknown, readonly ended: boolean) {
    super(errorText(reason));
  }
}

/** A live box Chromium, as this module tracks it. */
interface BoxChrome extends BrowserChrome {
  boxId: string;
  procId: string;
}

export class BoxBrowsers {
  /** boxId → the Chromiums running in it for this daemon. */
  private readonly live = new Map<string, Set<BoxChrome>>();
  /** Process ids this daemon started and has not finished stopping: never a leftover. */
  private readonly owned = new Set<string>();
  /**
   * Closes under way per project hash. A Chromium can close on its own (its channel failed, it
   * crashed) while `BrowserManager` already relaunches: the new one waits for the old one's end.
   */
  private readonly closingByProject = new Map<string, Set<Promise<void>>>();
  /** In-flight leftover sweeps per box, so a launch waits for one already running. */
  private readonly sweeping = new Map<string, Promise<void>>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly stopping = new AbortController();
  private readonly launchDeadlineMs: number;
  private readonly exitDeadlineMs: number;
  private readonly cdpMaxPayload: number;

  constructor(private readonly deps: BoxBrowsersDeps) {
    this.launchDeadlineMs = deps.launchDeadlineMs ?? DEFAULT_LAUNCH_DEADLINE_MS;
    this.exitDeadlineMs = deps.exitDeadlineMs ?? DEFAULT_EXIT_DEADLINE_MS;
    this.cdpMaxPayload = deps.cdpMaxPayload ?? BOX_CDP_MAX_PAYLOAD;
    this.unsubscribe.push(
      // A box back on its link: what a dropped link or a crashed daemon left running there goes.
      deps.hub.onConnectionChange((boxId, connected) => {
        if (connected) void this.sweepBox(boxId);
      }),
      // A destroyed box: its Chromiums are gone with it; their forwards and pages go now.
      deps.registry.onChange((boxId) => {
        const record = deps.registry.get(boxId);
        if (!record || record.state === "destroyed") void this.closeBox(boxId);
      })
    );
  }

  /** Whether `projectPath`'s Browser tab runs Chromium in its box (a Linux project box, an installer wired). */
  runsInBox(projectPath: string): boolean {
    if (!this.deps.installer) return false;
    const location = this.deps.registry.locate(projectPath);
    return location.kind === "box" && boxRunsBrowser(location.record);
  }

  /** `BrowserManager`'s seam: the launcher of a Linux box project, null for the host's Chromium. */
  launcherFor(projectPath: string): RemoteChromeLauncher | null {
    const installer = this.deps.installer;
    if (!installer || !this.runsInBox(projectPath)) return null;
    return { launch: (options) => this.launch(installer, projectPath, options.onProgress, options.signal) };
  }

  /** Stop leftovers in every box linked already (the wiring's attach: boxes that connected before it). */
  async sweepConnected(): Promise<void> {
    const linked = this.deps.registry.list().filter((record) => this.deps.hub.get(record.id)?.connected);
    await Promise.all(linked.map((record) => this.sweepBox(record.id)));
  }

  /** Close every box Chromium (daemon shutdown: before the box links close, so the processes end). */
  async stop(): Promise<void> {
    this.stopping.abort();
    for (const off of this.unsubscribe.splice(0)) off();
    await Promise.all([...this.live.keys()].map((boxId) => this.closeBox(boxId)));
  }

  /** Live box Chromiums, for tests and status. */
  list(): { boxId: string; procId: string; debugPort: number }[] {
    return [...this.live.values()].flatMap((set) => [...set].map((chrome) => ({ boxId: chrome.boxId, procId: chrome.procId, debugPort: chrome.debugPort })));
  }

  // ── launch ────────────────────────────────────────────────────────────────

  private async launch(
    installer: BoxBrowserInstaller,
    projectPath: string,
    onProgress: (line: string) => void,
    tabSignal: AbortSignal
  ): Promise<BrowserChrome> {
    if (this.stopping.signal.aborted) throw new BrowserError("The daemon is shutting down", 503);
    const signal = AbortSignal.any([tabSignal, this.stopping.signal]);
    if (signal.aborted) throw cancelled();
    const location = this.deps.registry.locate(projectPath);
    if (location.kind !== "box") throw new BrowserError("The project is not in a VM", 409);
    const { boxId, record } = location;
    if (record.state === "destroyed" || record.state === "destroying" || record.state === "destroy-failed") {
      throw new BrowserError("The project's VM was destroyed; its browser cannot start.", 409);
    }
    const connection = location.connection ?? this.deps.hub.get(boxId);
    if (!connection?.connected) {
      throw new BrowserError("The project's VM is not connected. Relaunch the browser once it is back.", 409);
    }

    const progress = (line: string): void => {
      const text = line.trim();
      if (text && !signal.aborted) onProgress(text.slice(0, PROGRESS_MAX_CHARS));
    };
    progress("Preparing Chromium in the VM…");
    let runtime: BoxBrowserRuntime;
    try {
      // A closed tab does not wait out an install: it is told to stop, and not waited for.
      runtime = await unlessAborted(
        installer.ensureBrowser(connection, { signal, onProgress: (line) => progress(`Installing Chromium in the VM: ${line}`) }),
        signal
      );
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (isGuiUnavailable(error)) {
        const reason = error.message.trim().replace(/[.\s]+$/, "");
        const hint = typeof error.hint === "string" && error.hint.trim() ? ` ${error.hint.trim()}` : "";
        throw new BrowserError(`Chromium is not available in the VM: ${reason}.${hint}`, 409);
      }
      throw new BrowserError(`Installing Chromium in the VM failed: ${errorText(error)}`, 500);
    }

    const hash = projectBrowserHash(projectPath);
    // A Chromium of this project still running in the box holds its profile: let one that is
    // closing finish, and stop any leftover.
    await Promise.all(this.closingByProject.get(hash) ?? []);
    await this.sweepBox(boxId, `${BOX_BROWSER_PROC_PREFIX}${hash}-`, connection);
    const profileDir = `${connection.sys.dataDir.replace(/\/+$/, "")}/browser-profiles/${hash}`;
    await connection.request("fs.mkdir", { path: profileDir, recursive: true, mode: 0o700 });
    if (signal.aborted) throw cancelled();

    progress("Starting Chromium in the VM…");
    const start = (sandboxed: boolean): Promise<BoxChrome> =>
      this.start(connection, boxId, hash, runtime.chromiumPath, profileDir, sandboxed, signal);
    try {
      if (runtime.noSandbox) return await start(false);
      try {
        return await start(true);
      } catch (error) {
        // As on the host: a sandbox that is not usable in the box is the one retryable failure,
        // retried once unsandboxed and flagged (never silently). Only while the link is up and
        // the first process is known to have ended: a link lost mid-connect reads like a crash
        // ("Connection closed"), and a second Chromium beside a live first one would fight it
        // for the profile.
        const retry =
          error instanceof StartFailure && error.ended && connection.connected && !signal.aborted && isRetryableSandboxFailure(error.reason);
        if (!retry) throw error;
        return await start(false);
      }
    } catch (error) {
      throw error instanceof StartFailure ? error.reason : error;
    }
  }

  /** One Chromium start: the process, its endpoint, the forward, puppeteer, a probe page. */
  private async start(
    connection: BoxConnection,
    boxId: string,
    hash: string,
    chromiumPath: string,
    profileDir: string,
    sandboxed: boolean,
    signal: AbortSignal
  ): Promise<BoxChrome> {
    const procId = `${BOX_BROWSER_PROC_PREFIX}${hash}-${randomUUID().slice(0, 8)}`;
    this.owned.add(procId);
    let proc: BoxProcess | null = null;
    let forward: BoxHostForward | null = null;
    let browser: Browser | null = null;
    let transport: ConnectionTransport | null = null;
    /** Set once tracked: a channel failure after the launch closes the Chromium. */
    let onFailure: ((error: Error) => void) | null = null;
    try {
      proc = connection.exec({
        command: chromiumPath,
        args: boxChromiumArgs(profileDir, !sandboxed),
        detach: { procId, bufferBytes: PROC_BUFFER_BYTES }
      });
      observe(proc, (error) => {
        this.deps.logger?.warn("box browser: Chromium's channel failed", { boxId, procId, error: error.message });
        onFailure?.(error);
      });
      const endpoint = await this.awaitEndpoint(proc, signal);
      forward = await connection.forwardToHost(endpoint.port);
      transport = await connectBoundedTransport(`ws://127.0.0.1:${forward.hostPort}${endpoint.path}`, this.cdpMaxPayload);
      browser = await puppeteer.connect({ transport, defaultViewport: null });
      // A present-but-broken sandbox lets the browser start and then aborts the first renderer:
      // make it fail here (as the host's tryLaunch does) so the unsandboxed retry can run.
      const probe = await browser.newPage();
      await probe.close();
      // The tab closed or the daemon began shutting down meanwhile.
      if (signal.aborted) throw cancelled();
    } catch (error) {
      // A socket puppeteer never took over is closed here; one it did closes with the browser.
      if (!browser) transport?.close();
      const ended = await this.teardown(connection, procId, proc, forward, browser);
      throw new StartFailure(error, ended);
    }
    const chrome = this.track(connection, boxId, hash, procId, proc, forward, browser, sandboxed);
    onFailure = () => void chrome.close();
    return chrome;
  }

  /** Chromium's debugging endpoint from its stderr, within the launch deadline. Keeps draining after. */
  private awaitEndpoint(proc: BoxProcess, signal: AbortSignal): Promise<{ port: number; path: string }> {
    // Nobody reads Chromium's stdout; its stderr is read for the endpoint and kept flowing after
    // (discarded), so neither holds the process back nor falls behind the box's buffer.
    proc.stdout.resume();
    return new Promise((resolve, reject) => {
      let pending = "";
      let tail = "";
      let settled = false;
      const finish = (error: Error | null, endpoint?: { port: number; path: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        proc.off("exit", onExit);
        proc.off("error", onError);
        proc.off("detached", onDetached);
        proc.stderr.off("data", onData);
        proc.stderr.resume();
        if (error) reject(error);
        else resolve(endpoint!);
      };
      const tailText = (): string => (tail.trim() ? `: ${tail.trim().slice(-STDERR_TAIL_CHARS)}` : "");
      const onData = (chunk: Buffer | string): void => {
        const text = String(chunk);
        tail = (tail + text).slice(-STDERR_TAIL_CHARS);
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const endpoint = parseDevtoolsListening(line);
          if (endpoint) {
            finish(null, endpoint);
            return;
          }
        }
        if (pending.length > 64 * 1024) pending = pending.slice(-1024);
      };
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void =>
        finish(new BrowserError(`Chromium in the VM exited (${exitSignal ?? `code ${code}`}) before it was ready${tailText()}`, 500));
      const onError = (error: Error): void => finish(new BrowserError(`Chromium in the VM could not start: ${error.message}`, 500));
      const onDetached = (): void => finish(new BrowserError("The connection to the VM dropped while Chromium was starting.", 409));
      const onAbort = (): void => finish(cancelled());
      const timer = setTimeout(
        () => finish(new BrowserError(`Chromium in the VM did not expose a debugging endpoint within ${Math.max(1, Math.round(this.launchDeadlineMs / 1000))} s${tailText()}`, 500)),
        this.launchDeadlineMs
      );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      proc.stderr.on("data", onData);
      proc.on("exit", onExit);
      proc.on("error", onError);
      proc.on("detached", onDetached);
    });
  }

  private track(
    connection: BoxConnection,
    boxId: string,
    hash: string,
    procId: string,
    proc: BoxProcess,
    forward: BoxHostForward,
    browser: Browser,
    sandboxed: boolean
  ): BoxChrome {
    let closing: Promise<void> | null = null;
    const offStatus = connection.onStatus((connected) => {
      // A link that drops takes the CDP socket with it: disconnect now (not when TCP notices)
      // so the tabs say so and the next subscribe relaunches.
      if (!connected && browser.connected) void browser.disconnect().catch(() => undefined);
    });
    const chrome: BoxChrome = {
      boxId,
      procId,
      browser,
      sandboxed,
      debugPort: forward.hostPort,
      // Its DevTools frontend would come from the box: never onto the daemon's origin.
      trustedDevtools: false,
      close: () => {
        if (closing) return closing;
        const run = (async () => {
          offStatus();
          this.live.get(boxId)?.delete(chrome);
          if (this.live.get(boxId)?.size === 0) this.live.delete(boxId);
          await this.teardown(connection, procId, proc, forward, browser);
        })();
        closing = run;
        let pending = this.closingByProject.get(hash);
        if (!pending) {
          pending = new Set();
          this.closingByProject.set(hash, pending);
        }
        pending.add(run);
        void run.then(() => {
          pending.delete(run);
          if (pending.size === 0 && this.closingByProject.get(hash) === pending) this.closingByProject.delete(hash);
        });
        return run;
      },
      lostReason: () => {
        const record = this.deps.registry.get(boxId);
        if (!record || record.state === "destroyed") return "The project's VM was destroyed.";
        return connection.connected ? null : "The connection to the VM dropped. Relaunch once it is back.";
      }
    };
    // Chromium gone (crash, link dropped, closed): its process, forward and id go too.
    browser.once("disconnected", () => void chrome.close());
    let set = this.live.get(boxId);
    if (!set) {
      set = new Set();
      this.live.set(boxId, set);
    }
    set.add(chrome);
    return chrome;
  }

  /**
   * End a Chromium start in any state: CDP close, the process stopped and released, the forward
   * closed. Resolves whether the process is known to have ended (or never started).
   */
  private async teardown(
    connection: BoxConnection,
    procId: string,
    proc: BoxProcess | null,
    forward: BoxHostForward | null,
    browser: Browser | null
  ): Promise<boolean> {
    let ended = proc === null;
    try {
      if (browser?.connected) await withDeadline(browser.close(), this.exitDeadlineMs).catch(() => undefined);
      if (proc && connection.connected) {
        ended = await waitExit(proc, this.exitDeadlineMs);
        if (!ended && !unobservable.has(proc) && connection.connected) {
          proc.kill("SIGKILL");
          await connection.request("proc.signal", { procId, signal: "SIGKILL" }).catch(() => undefined);
          ended = await waitExit(proc, this.exitDeadlineMs);
        }
        // Its channel is gone (failed, or detached and the link is back): end it by its id.
        if (!ended && unobservable.has(proc) && connection.connected) ended = await this.stopById(connection, procId);
        if (ended) await connection.request("proc.release", { procId }).catch(() => undefined);
      }
    } finally {
      // Still running in the box (the link was away): no longer ours, so the next sweep stops it.
      this.owned.delete(procId);
      // A listener's close waits for its open connections; one to a Chromium that is still
      // running (the link was away) may never end, so it gets the same deadline.
      await withDeadline(forward?.close() ?? Promise.resolve(), this.exitDeadlineMs).catch(() => undefined);
    }
    return ended;
  }

  private async closeBox(boxId: string): Promise<void> {
    const set = this.live.get(boxId);
    if (!set) return;
    await Promise.all([...set].map((chrome) => chrome.close()));
  }

  // ── leftovers ─────────────────────────────────────────────────────────────

  /**
   * Stop and release the box's Chromium processes this daemon does not own (`prefix` narrows it
   * to one project's). With a `connection` (a launch), a leftover that does not end fails the
   * launch; a reconnect's sweep only logs.
   */
  private sweepBox(boxId: string, prefix = BOX_BROWSER_PROC_PREFIX, launching?: BoxConnection): Promise<void> {
    const previous = this.sweeping.get(boxId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const connection = launching ?? this.deps.hub.get(boxId);
      if (!connection?.connected) return;
      let procs: BoxDetachedProcInfo[];
      try {
        procs = await connection.request("proc.list", {});
      } catch (error) {
        if (launching) throw new BrowserError(`The VM could not list its processes: ${errorText(error)}`, 409);
        this.deps.logger?.warn("box browser: listing processes failed", { boxId, error: errorText(error) });
        return;
      }
      for (const info of procs) {
        if (!info.procId.startsWith(prefix) || this.owned.has(info.procId)) continue;
        if (info.running && !(await this.stopLeftover(connection, info))) {
          const message = "An earlier Chromium of this project is still running in the VM and could not be stopped.";
          if (launching) throw new BrowserError(message, 409);
          this.deps.logger?.warn(`box browser: ${message}`, { boxId, procId: info.procId });
          continue;
        }
        await connection.request("proc.release", { procId: info.procId }).catch(() => undefined);
      }
    });
    const settled = run.catch(() => undefined);
    this.sweeping.set(boxId, settled);
    void settled.then(() => {
      if (this.sweeping.get(boxId) === settled) this.sweeping.delete(boxId);
    });
    return run;
  }

  /** A process this daemon can no longer follow on its own channel: listed, and stopped if it runs. */
  private async stopById(connection: BoxConnection, procId: string): Promise<boolean> {
    const listed = await connection.request("proc.list", {}).catch(() => null);
    if (listed === null) return false;
    const info = listed.find((entry) => entry.procId === procId);
    if (!info || !info.running) return true;
    return this.stopLeftover(connection, info);
  }

  /** SIGKILL a leftover and wait for the box to report its end (on an attach), within the deadline. */
  private async stopLeftover(connection: BoxConnection, info: BoxDetachedProcInfo): Promise<boolean> {
    let viewer: BoxProcess | null = null;
    try {
      viewer = connection.attach(info.procId, info.outputBytes);
      viewer.stdout.resume();
      viewer.stderr.resume();
      // Permanent: the viewer may fail (an overrun, the link) after the wait below has settled.
      observe(viewer, () => undefined);
    } catch {
      viewer = null;
    }
    const exited = viewer ? waitExit(viewer, this.exitDeadlineMs) : Promise.resolve(false);
    await connection.request("proc.signal", { procId: info.procId, signal: "SIGKILL" }).catch(() => viewer?.kill("SIGKILL"));
    if (await exited) return true;
    const listed = await connection.request("proc.list", {}).catch(() => null);
    const still = listed?.find((entry) => entry.procId === info.procId);
    return listed !== null && (still === undefined || !still.running);
  }
}
