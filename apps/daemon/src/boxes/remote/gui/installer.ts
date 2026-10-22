/**
 * The box GUI installer: probes a Linux box for Chrome and the desktop stack, installs what is
 * missing (as root or through passwordless sudo, with apt or dnf/yum), and checks Chrome's sandbox.
 *
 * Runs are memoized per (box, feature): concurrent callers share one run, a successful result is
 * kept until `forget(boxId)`, a failed one is dropped so the next call retries. A caller's signal
 * aborts only its own wait; when the last waiter of a run leaves, the run is aborted too (the
 * command in the box gets SIGTERM; apt's `dpkg --configure -a` at the next run's start repairs an
 * interrupted install). Commands carry deadlines (probe 1 min, install 15 min, Chrome start 3 min).
 */

import type { DesktopHostStatus } from "@orquester/api";

import type { BoxConnection } from "../../contracts.ts";
import { redactSetupText, runBoxCommand, type BoxCommandResult } from "../../service/box-exec.ts";
import {
  NON_LINUX_BROWSER,
  NON_LINUX_DESKTOP,
  boxDesktopInstallHint,
  canInstall,
  chromeArch,
  desktopInstallPlan,
  evaluateBoxDesktop,
  guiProbeScript,
  manualInstallCommand,
  nonLinuxDesktopStatus,
  packageManagerOf,
  parseGuiProbe,
  type BoxGuiFacts
} from "./probe.ts";
import {
  EXIT_UNSUPPORTED,
  browserInstallScript,
  chromeStartScript,
  desktopInstallScript,
  parseChromeStart
} from "./scripts.ts";
import { SharedRun } from "./shared-run.ts";
import {
  BoxGuiUnavailableError,
  type BoxBrowserRuntime,
  type BoxGuiFeature,
  type BoxGuiInstaller,
  type BoxGuiInstallerDeps,
  type BoxGuiProgress
} from "./types.ts";

export const PROBE_TIMEOUT_MS = 60_000;
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
export const CHROME_START_TIMEOUT_MS = 3 * 60_000;
/** Lines of the install log a failure message ends with. */
const TAIL_LINES = 15;

const NOT_CONNECTED = "The box is not connected right now.";
const NOT_CONNECTED_HINT = "Wait for it to reconnect, then open the tab again.";

type MemoEntry<T> = { run: SharedRun<T> } | { value: T };

/** The per-box memo of one feature's runs. */
class FeatureMemo<T> {
  private readonly entries = new Map<string, MemoEntry<T>>();

  ensure(
    boxId: string,
    work: (signal: AbortSignal, progress: BoxGuiProgress) => Promise<T>,
    options: { signal?: AbortSignal; onProgress?: BoxGuiProgress }
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const entry = this.entries.get(boxId);
    if (entry && "value" in entry) return Promise.resolve(entry.value);
    // An abandoned run is still winding down; a new caller starts afresh rather than inherit its abort.
    if (entry && !entry.run.abandoned) return entry.run.join(options);
    const holder: { run: SharedRun<T> } = {
      run: new SharedRun<T>(work, () => {
        if (this.entries.get(boxId) === holder) this.entries.delete(boxId);
      })
    };
    this.entries.set(boxId, holder);
    holder.run.promise.then(
      (value) => {
        if (this.entries.get(boxId) === holder) this.entries.set(boxId, { value });
      },
      () => {
        if (this.entries.get(boxId) === holder) this.entries.delete(boxId);
      }
    );
    return holder.run.join(options);
  }

  forget(boxId: string): void {
    const entry = this.entries.get(boxId);
    this.entries.delete(boxId);
    if (entry && "run" in entry) entry.run.abort(new BoxGuiUnavailableError("The box was removed."));
  }
}

export function createBoxGuiInstaller(deps: BoxGuiInstallerDeps = {}): BoxGuiInstaller {
  return new GuiInstaller(deps);
}

class GuiInstaller implements BoxGuiInstaller {
  private readonly desktops = new FeatureMemo<DesktopHostStatus>();
  private readonly browsers = new FeatureMemo<BoxBrowserRuntime>();

  private readonly probeMs: number;
  private readonly installMs: number;
  private readonly chromeStartMs: number;

  constructor(private readonly deps: BoxGuiInstallerDeps) {
    this.probeMs = deps.timeouts?.probeMs ?? PROBE_TIMEOUT_MS;
    this.installMs = deps.timeouts?.installMs ?? INSTALL_TIMEOUT_MS;
    this.chromeStartMs = deps.timeouts?.chromeStartMs ?? CHROME_START_TIMEOUT_MS;
  }

  async desktopStatus(connection: BoxConnection, options: { signal?: AbortSignal } = {}): Promise<DesktopHostStatus> {
    if (connection.sys.os !== "linux") return nonLinuxDesktopStatus();
    requireConnected(connection);
    const facts = await this.probe(connection, { desktop: true, browser: false }, options.signal ?? new AbortController().signal);
    return this.withHint(connection, facts);
  }

  ensureDesktop(connection: BoxConnection, options: { signal?: AbortSignal; onProgress?: BoxGuiProgress } = {}): Promise<DesktopHostStatus> {
    if (connection.sys.os !== "linux") return Promise.reject(new BoxGuiUnavailableError(NON_LINUX_DESKTOP, "Create the project on a Linux box to use a desktop."));
    return this.desktops.ensure(connection.boxId, (signal, progress) => this.installDesktop(connection, signal, progress), options);
  }

  ensureBrowser(connection: BoxConnection, options: { signal?: AbortSignal; onProgress?: BoxGuiProgress } = {}): Promise<BoxBrowserRuntime> {
    if (connection.sys.os !== "linux") return Promise.reject(new BoxGuiUnavailableError(NON_LINUX_BROWSER, "This box's Browser tab uses Chromium on the host instead."));
    return this.browsers.ensure(connection.boxId, (signal, progress) => this.installBrowser(connection, signal, progress), options);
  }

  forget(boxId: string): void {
    this.desktops.forget(boxId);
    this.browsers.forget(boxId);
  }

  // -------------------------------------------------------------------------
  // Desktop
  // -------------------------------------------------------------------------

  private async installDesktop(connection: BoxConnection, signal: AbortSignal, progress: BoxGuiProgress): Promise<DesktopHostStatus> {
    requireConnected(connection);
    progress("Checking the desktop packages in the box");
    const facts = await this.probe(connection, { desktop: true, browser: false }, signal);
    const { status, missingPackages } = evaluateBoxDesktop(facts);
    const manager = packageManagerOf(facts);
    const user = connection.sys.user;
    if (manager === null) {
      if (status.available || missingPackages.length === 0) return usable(this.withHint(connection, facts), false);
      throw new BoxGuiUnavailableError(
        `Orquester installs the desktop packages only with apt or dnf/yum, and this box has ${facts.packageCommand ?? "no package manager"}. Missing: ${missingPackages.join(", ")}.`,
        "Use an Ubuntu, Debian or Fedora image, or install those packages in the box yourself."
      );
    }
    const plan = desktopInstallPlan(facts, missingPackages, manager);
    const all = [...plan.required, ...plan.optional];
    // Nothing to install (an old tmux is not fixed by installing): the stack is what it is.
    if (plan.missing.length === 0 && facts.machineId) return usable(this.withHint(connection, facts), false);
    if (!canInstall(facts)) {
      if (status.available || plan.required.length === 0) return usable(this.withHint(connection, facts), false);
      throw new BoxGuiUnavailableError(
        `Desktops need ${all.map((choice) => choice[0]).join(" ")} in this box, and its user ${user} has no root access or passwordless sudo to install them.`,
        `Install them in the box: ${manualInstallCommand(manager, all)}`
      );
    }
    if (plan.missing.length > 0) {
      progress(`Installing ${plan.missing.join(" ")} in the box; the first desktop takes a few minutes.`);
    }
    const started = Date.now();
    const result = await this.runScript(connection, { script: desktopInstallScript({ manager, ...plan }), asRoot: true, timeoutMs: this.installMs, what: "Installing the desktop packages" }, facts, signal, progress);
    if (result.code !== 0) {
      this.warn("box desktop install failed", connection, "desktop", result);
      throw new BoxGuiUnavailableError(
        `${failurePrefix(connection, result, "Installing the desktop packages in the box")}\n${tailLines(result.tail)}`,
        `Install them in the box yourself (${manualInstallCommand(manager, plan.required.length > 0 ? plan.required : all)}), then open the desktop again.`
      );
    }
    progress(`Installed in ${Math.round((Date.now() - started) / 1000)} s; checking again`);
    const after = await this.probe(connection, { desktop: true, browser: false }, signal);
    const final = usable(this.withHint(connection, after), true);
    progress("The desktop stack is ready.");
    return final;
  }

  private withHint(connection: BoxConnection, facts: BoxGuiFacts): DesktopHostStatus {
    const { status, missingPackages } = evaluateBoxDesktop(facts);
    return { ...status, installHint: boxDesktopInstallHint(facts, missingPackages, connection.sys.user) };
  }

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------

  private async installBrowser(connection: BoxConnection, signal: AbortSignal, progress: BoxGuiProgress): Promise<BoxBrowserRuntime> {
    requireConnected(connection);
    progress("Looking for Chrome or Chromium in the box");
    let facts = await this.probe(connection, { desktop: false, browser: true }, signal);
    for (const skipped of facts.chromeSkipped) progress(`Skipped ${skipped}: a snap shim or a binary that does not start`);
    if (facts.chrome === null) {
      const arch = chromeArch(facts.machine);
      const manager = packageManagerOf(facts);
      if (arch === null) {
        throw new BoxGuiUnavailableError(`Google Chrome has no Linux build for ${facts.machine || "this"} boxes.`, "Use an x86-64 or arm64 box for the in-box browser.");
      }
      if (manager === null) {
        throw new BoxGuiUnavailableError(
          `There is no Chrome or Chromium in this box, and Orquester installs one only with apt or dnf/yum (this box has ${facts.packageCommand ?? "no package manager"}).`,
          "Install Chrome or Chromium (not the snap) in the box, or use an Ubuntu, Debian or Fedora image."
        );
      }
      if (!canInstall(facts)) {
        throw new BoxGuiUnavailableError(
          `There is no Chrome or Chromium in this box, and its user ${connection.sys.user} has no root access or passwordless sudo to install one.`,
          "Install google-chrome-stable (or Chromium, not the snap) in the box, then open the tab again."
        );
      }
      progress("Installing Google Chrome from Google's signed repository; this takes a minute or two.");
      const started = Date.now();
      const result = await this.runScript(connection, { script: browserInstallScript(manager), asRoot: true, timeoutMs: this.installMs, what: "Installing Google Chrome" }, facts, signal, progress);
      if (result.code === EXIT_UNSUPPORTED) {
        throw new BoxGuiUnavailableError(`Google Chrome has no Linux build for this box's architecture.`, "Use an x86-64 or arm64 box for the in-box browser.");
      }
      if (result.code !== 0) {
        this.warn("box browser install failed", connection, "browser", result);
        throw new BoxGuiUnavailableError(
          `${failurePrefix(connection, result, "Installing Google Chrome in the box")}\n${tailLines(result.tail)}`,
          "Install google-chrome-stable (or Chromium, not the snap) in the box yourself, then open the tab again."
        );
      }
      progress(`Installed in ${Math.round((Date.now() - started) / 1000)} s`);
      facts = await this.probe(connection, { desktop: false, browser: true }, signal);
      if (facts.chrome === null) {
        throw new BoxGuiUnavailableError("Google Chrome was installed, but the box has no working chrome binary.", "Check `google-chrome-stable --version` in a box terminal.");
      }
    }
    const chrome = facts.chrome;
    progress(`Starting ${chrome.version || chrome.path} once to check its sandbox`);
    const root = facts.uid === 0 || connection.sys.isRoot;
    const trySandbox = !root && !connection.sys.container;
    const result = await this.runScript(
      connection,
      { script: chromeStartScript(), args: [chrome.path, trySandbox ? "1" : "0"], asRoot: false, timeoutMs: this.chromeStartMs, what: "Starting Chrome" },
      facts,
      signal
    );
    const start = parseChromeStart(result.stdout);
    const runtime = { chromiumPath: chrome.path, version: chrome.version || null };
    if (start.sandbox === true) {
      progress("Chrome starts with its sandbox.");
      return { ...runtime, noSandbox: false };
    }
    if (start.noSandbox === true) {
      progress(
        root
          ? "Chrome runs without its sandbox: the box user is root."
          : connection.sys.container
            ? "Chrome runs without its sandbox: the box is a container."
            : "Chrome's sandbox cannot start in this box (user namespaces are blocked); it runs without it."
      );
      return { ...runtime, noSandbox: true };
    }
    this.warn("box chrome does not start", connection, "browser", result);
    const log = start.log.length > 0 ? start.log.join("\n") : tailLines(result.tail);
    throw new BoxGuiUnavailableError(`Chrome is installed at ${chrome.path} but does not start in this box:\n${log}`, "Open a box terminal and run it with --headless=new to see why.");
  }

  // -------------------------------------------------------------------------
  // Running commands in the box
  // -------------------------------------------------------------------------

  private async probe(connection: BoxConnection, parts: { desktop: boolean; browser: boolean }, signal: AbortSignal): Promise<BoxGuiFacts> {
    const result = await this.runScript(connection, { script: guiProbeScript(parts), asRoot: false, timeoutMs: this.probeMs, what: "Checking the box" }, null, signal);
    if (result.code !== 0) {
      throw new BoxGuiUnavailableError(`${failurePrefix(connection, result, "Checking the box")}\n${tailLines(result.tail)}`, connection.connected ? null : NOT_CONNECTED_HINT);
    }
    return parseGuiProbe(result.stdout);
  }

  /**
   * Run a POSIX script in the box (`sh -c <script> sh <args…>`), as root through `sudo -n` when
   * `asRoot` and the box user is not root. Resolves with its exit status; a deadline or a command
   * that cannot start becomes a {@link BoxGuiUnavailableError}; the caller's abort rejects with its
   * reason.
   */
  private async runScript(
    connection: BoxConnection,
    spec: { script: string; args?: string[]; asRoot: boolean; timeoutMs: number; what: string },
    facts: BoxGuiFacts | null,
    signal: AbortSignal,
    progress?: BoxGuiProgress
  ): Promise<BoxCommandResult> {
    const shArgs = ["-c", spec.script, "sh", ...(spec.args ?? [])];
    const root = facts ? facts.uid === 0 : connection.sys.isRoot;
    const command = spec.asRoot && !root ? { command: "sudo", args: ["-n", "/bin/sh", ...shArgs] } : { command: "/bin/sh", args: shArgs };
    const deadline = AbortSignal.timeout(spec.timeoutMs);
    // apt repeats "Waiting for cache lock: … held by process N" every second while another
    // install runs: one line says it.
    let previous = "";
    try {
      return await runBoxCommand(connection, command, {
        signal: AbortSignal.any([signal, deadline]),
        ...(progress
          ? {
              onLine: (line: string) => {
                const text = redactSetupText(line).trimEnd();
                if (text.length === 0 || text === previous) return;
                previous = text;
                progress(text);
              }
            }
          : {})
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted) {
        throw new BoxGuiUnavailableError(`${spec.what} did not finish within ${formatDuration(spec.timeoutMs)}.`, "Open a box terminal to see what it is waiting for, then try again.");
      }
      if (!connection.connected) throw new BoxGuiUnavailableError(NOT_CONNECTED, NOT_CONNECTED_HINT);
      throw new BoxGuiUnavailableError(`${spec.what} could not run in the box: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private warn(message: string, connection: BoxConnection, feature: BoxGuiFeature, result: BoxCommandResult): void {
    this.deps.logger?.warn(message, { boxId: connection.boxId, feature, code: result.code, signal: result.signal });
  }
}

/** `status` when a desktop can start; else the refusal saying why (required tools missing, tmux too old). */
function usable(status: DesktopHostStatus, installed: boolean): DesktopHostStatus {
  if (status.available) return status;
  const missingTools = status.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.name);
  const reasons = [
    ...(missingTools.length > 0 ? [`${missingTools.join(", ")} ${installed ? "still " : ""}missing`] : []),
    ...status.warnings.filter((warning) => warning.startsWith("tmux"))
  ];
  const why = reasons.join("; ") || "the desktop tools are unusable";
  throw new BoxGuiUnavailableError(
    installed ? `The desktop packages are installed, but a desktop still cannot start in this box: ${why}.` : `A desktop cannot start in this box: ${why}.`,
    "Use a newer Ubuntu, Debian or Fedora image for desktops."
  );
}

function requireConnected(connection: BoxConnection): void {
  if (!connection.connected) throw new BoxGuiUnavailableError(NOT_CONNECTED, NOT_CONNECTED_HINT);
}

/** "<what> failed (exit 3):" or, when the link dropped mid-way, that. */
function failurePrefix(connection: BoxConnection, result: BoxCommandResult, what: string): string {
  if (result.code === null && !connection.connected) return `${what} stopped: the box disconnected.`;
  return `${what} failed (${result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.code}`}):`;
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function tailLines(tail: string): string {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-TAIL_LINES)
    .join("\n");
}
