import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { BoxSysInfo } from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxProcess } from "../../contracts.ts";
import { localSysInfo } from "../../testing.ts";
import { BoxGuiUnavailableError, createBoxGuiInstaller } from "./index.ts";

type Kind = "probe" | "desktop-install" | "browser-install" | "chrome-start" | "fonts-install";

interface Answer {
  stdout?: string;
  code?: number;
  /** Never exits on its own (until killed). */
  hang?: boolean;
}

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1;
  readonly procId = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  finish(stdout: string, code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end(stdout);
    this.stderr.end();
    setImmediate(() => {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("exit", code, signal);
    });
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.finish("", null, signal);
    return true;
  }
  resize(): void {}
}

interface Call {
  kind: Kind;
  command: string;
  args: string[];
  proc: FakeProcess;
}

/**
 * A box that answers the installer's scripts from its state: which packages are installed,
 * whether Chrome is there and starts with or without its sandbox.
 */
class FakeBox {
  connected = true;
  desktop = false;
  chrome = false;
  /** CJK and emoji fonts are installed (most tests: yes, so their call lists stay short). */
  fonts = true;
  uid = 0;
  sudo = false;
  pm = "apt-get";
  machine = "x86_64";
  tmux = "tmux 3.4";
  sandbox: "ok" | "fail" = "ok";
  noSandbox: "ok" | "fail" = "ok";
  readonly calls: Call[] = [];
  /** Per-kind overrides, consumed in order. */
  readonly answers: Partial<Record<Kind, Answer[]>> = {};
  /** Called when an install starts, before it answers (to hold it open). */
  onInstall: ((call: Call) => void) | null = null;

  constructor(readonly sys: BoxSysInfo) {}

  connection(): BoxConnection {
    const box = this;
    return {
      boxId: "box1",
      get sys() {
        return box.sys;
      },
      get connected() {
        return box.connected;
      },
      exec: (options: BoxExecOptions) => box.exec(options)
    } as unknown as BoxConnection;
  }

  count(kind: Kind): number {
    return this.calls.filter((call) => call.kind === kind).length;
  }

  private exec(options: BoxExecOptions): BoxProcess {
    const proc = new FakeProcess();
    const args = options.args ?? [];
    const script = args[args.indexOf("-c") + 1] ?? "";
    const kind: Kind = script.includes("kv os-id")
      ? "probe"
      : script.includes("Desktop packages are installed.")
        ? "desktop-install"
        : script.includes("Google Chrome is installed.")
          ? "browser-install"
          : script.includes("Fonts are installed.")
            ? "fonts-install"
            : "chrome-start";
    const call = { kind, command: options.command, args, proc };
    this.calls.push(call);
    options.signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
    const override = this.answers[kind]?.shift();
    if (kind === "desktop-install" || kind === "browser-install" || kind === "fonts-install") this.onInstall?.(call);
    setImmediate(() => {
      if (override?.hang) return;
      if (override) return proc.finish(override.stdout ?? "", override.code ?? 0);
      this.answer(call, script);
    });
    return proc as unknown as BoxProcess;
  }

  private answer(call: Call, script: string): void {
    if (call.proc.exitCode !== null || call.proc.signalCode !== null) return;
    switch (call.kind) {
      case "probe":
        return call.proc.finish(this.probe(script), 0);
      case "desktop-install":
        this.desktop = true;
        return call.proc.finish("Installing the desktop packages: tigervnc-standalone-server openbox\nDesktop packages are installed.\n", 0);
      case "browser-install":
        this.chrome = true;
        return call.proc.finish("Adding Google's signed Chrome repository\nGoogle Chrome is installed.\n", 0);
      case "fonts-install":
        this.fonts = true;
        return call.proc.finish("Installing fonts: fonts-noto-cjk fonts-noto-color-emoji\nFonts are installed.\n", 0);
      case "chrome-start": {
        const trySandbox = call.args[call.args.length - 1] === "1" && this.uid !== 0;
        if (trySandbox && this.sandbox === "ok") return call.proc.finish("sandbox=ok\n", 0);
        const lines = trySandbox ? ["sandbox=fail", "sandbox-log: No usable sandbox!"] : [];
        lines.push(this.noSandbox === "ok" ? "nosandbox=ok" : "nosandbox=fail\nnosandbox-log: Trace/breakpoint trap");
        return call.proc.finish(`${lines.join("\n")}\n`, this.noSandbox === "ok" ? 0 : 1);
      }
    }
  }

  private probe(script: string): string {
    const lines = ["os-id=ubuntu", "os-like=debian", "os-version=24.04", `machine=${this.machine}`, `uid=${this.uid}`, `sudo=${this.sudo ? 1 : 0}`, `pm=${this.pm}`, "passwd=1"];
    if (script.includes("tool:")) {
      const have = (path: string) => (this.desktop ? path : "");
      lines.push(
        `tool:Xvnc=${have("/usr/bin/Xvnc")}`,
        `tool:openbox=${have("/usr/bin/openbox")}`,
        "tool:dbus-daemon=/usr/bin/dbus-daemon",
        "tool:tmux=/usr/bin/tmux",
        `tool:pulseaudio=${have("/usr/bin/pulseaudio")}`,
        `tool:pactl=${have("/usr/bin/pactl")}`,
        `tool:ffmpeg=${have("/usr/bin/ffmpeg")}`,
        `tool:xcompmgr=${have("/usr/bin/xcompmgr")}`,
        `tool:xterm=${have("/usr/bin/xterm")}`,
        `tmux-version=${this.tmux}`,
        `mesa=${this.desktop ? 1 : 0}`,
        "machine-id=1",
        `fonts=${this.desktop ? 1 : 0}`
      );
      if (this.desktop) {
        lines.push(">>> ffmpeg-devices", " DE pulse           Pulse audio output", "<<< ffmpeg-devices", ">>> ffmpeg-encoders", " A....D libopus              libopus Opus", "<<< ffmpeg-encoders");
      }
    }
    if (script.includes("fc-list")) lines.push(`cjk-fonts=${this.fonts ? 1 : 0}`, `emoji-font=${this.fonts ? 1 : 0}`);
    if (this.chrome) lines.push("chrome=/opt/google/chrome/chrome", "chrome-version=Google Chrome 156.0.8078.47");
    return `${lines.join("\n")}\n`;
  }
}

function box(sys: Partial<BoxSysInfo> = {}): FakeBox {
  return new FakeBox(localSysInfo({ os: "linux", user: "root", isRoot: true, container: false, ...sys }));
}

async function rejectsGui(promise: Promise<unknown>, pattern: RegExp): Promise<BoxGuiUnavailableError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BoxGuiUnavailableError, `expected BoxGuiUnavailableError, got ${String(error)}`);
    assert.equal(error.code, "BOX_GUI_UNAVAILABLE");
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a rejection");
}

test("a non-Linux box: desktopStatus explains, ensure* refuse, nothing runs in the box", async () => {
  const fake = box({ os: "darwin" });
  const installer = createBoxGuiInstaller();
  const status = await installer.desktopStatus(fake.connection());
  assert.equal(status.available, false);
  assert.equal(status.installHint, "Desktops run only in Linux VMs.");
  await rejectsGui(installer.ensureDesktop(fake.connection()), /runs? only in Linux VMs/);
  await rejectsGui(installer.ensureBrowser(fake.connection()), /runs only in Linux VMs/);
  assert.equal(fake.calls.length, 0);
});

test("desktopStatus probes without installing and says what will be installed", async () => {
  const fake = box();
  const status = await createBoxGuiInstaller().desktopStatus(fake.connection());
  assert.equal(status.available, false);
  assert.match(status.installHint ?? "", /^Orquester installs tigervnc-standalone-server openbox .* in the box when a desktop opens\.$/);
  assert.equal(status.installsOnOpen, true, "a root box installs what is missing by itself");
  assert.deepEqual(fake.calls.map((call) => call.kind), ["probe"]);
  assert.equal(fake.calls[0]!.command, "/bin/sh");
});

test("ensureDesktop as root installs once, re-probes, streams progress, and is memoized", async () => {
  const fake = box();
  const installer = createBoxGuiInstaller();
  const lines: string[] = [];
  const status = await installer.ensureDesktop(fake.connection(), { onProgress: (line) => lines.push(line) });
  assert.equal(status.available, true);
  assert.equal(status.audioAvailable, true);
  assert.equal(status.installHint, null);
  assert.equal(status.installsOnOpen, undefined, "nothing left to install");
  assert.deepEqual(fake.calls.map((call) => call.kind), ["probe", "desktop-install", "probe"]);
  const install = fake.calls[1]!;
  assert.equal(install.command, "/bin/sh", "root runs the script directly");
  assert.ok(lines.includes("Desktop packages are installed."), lines.join("\n"));
  assert.ok(lines.at(-1) === "The desktop stack is ready.");

  assert.equal(await installer.ensureDesktop(fake.connection()), status, "the second call is the memo");
  assert.equal(fake.calls.length, 3);
  installer.forget("box1");
  await installer.ensureDesktop(fake.connection());
  assert.deepEqual(fake.calls.slice(3).map((call) => call.kind), ["probe"], "after forget it checks again (and finds it installed)");
});

test("progress drops blank lines and apt's repeated lock-wait line", async () => {
  const fake = box();
  const wait = "Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 42 (apt-get)...";
  fake.answers["desktop-install"] = [{ stdout: `${wait}\n${wait}\n\n${wait}\nSetting up openbox\nDesktop packages are installed.\n` }];
  fake.onInstall = () => {
    fake.desktop = true;
  };
  const lines: string[] = [];
  await createBoxGuiInstaller().ensureDesktop(fake.connection(), { onProgress: (line) => lines.push(line) });
  assert.deepEqual(
    lines.filter((line) => line === wait || line === "Setting up openbox"),
    [wait, "Setting up openbox"]
  );
});

test("an install that leaves the desktop unusable is refused with the reason", async () => {
  const fake = box();
  fake.answers["desktop-install"] = [{ stdout: "Desktop packages are installed.\n" }];
  await rejectsGui(
    createBoxGuiInstaller().ensureDesktop(fake.connection()),
    /^The desktop packages are installed, but a desktop still cannot start in this box: Xvnc, openbox still missing\.$/
  );
});

test("a desktop stack that installing cannot fix (tmux older than 3.2) is refused, not resolved", async () => {
  const installed = box();
  installed.desktop = true;
  installed.tmux = "tmux 3.1c";
  await rejectsGui(createBoxGuiInstaller().ensureDesktop(installed.connection()), /^A desktop cannot start in this box: tmux is older than 3\.2/);
  assert.equal(installed.count("desktop-install"), 0);

  const fresh = box();
  fresh.tmux = "tmux 3.1c";
  await rejectsGui(createBoxGuiInstaller().ensureDesktop(fresh.connection()), /^The desktop packages are installed, but a desktop still cannot start in this box: tmux is older than 3\.2/);
});

test("a sudoer installs through sudo -n; the probe and Chrome check run as the user", async () => {
  const fake = box({ user: "dev", isRoot: false, canElevate: true });
  fake.uid = 1000;
  fake.sudo = true;
  const installer = createBoxGuiInstaller();
  await installer.ensureDesktop(fake.connection());
  const install = fake.calls.find((call) => call.kind === "desktop-install")!;
  assert.equal(install.command, "sudo");
  assert.deepEqual(install.args.slice(0, 3), ["-n", "/bin/sh", "-c"]);
  const runtime = await installer.ensureBrowser(fake.connection());
  assert.deepEqual(runtime, { chromiumPath: "/opt/google/chrome/chrome", version: "Google Chrome 156.0.8078.47", noSandbox: false });
  for (const call of fake.calls.filter((c) => c.kind === "probe" || c.kind === "chrome-start")) assert.equal(call.command, "/bin/sh");
  assert.equal(fake.calls.find((call) => call.kind === "chrome-start")!.args.at(-1), "1", "a normal user tries the sandbox");
});

test("no root and no sudo: a refusal naming the packages and the command, nothing installed", async () => {
  const fake = box({ user: "dev", isRoot: false });
  fake.uid = 1000;
  const installer = createBoxGuiInstaller();
  const error = await rejectsGui(installer.ensureDesktop(fake.connection()), /^Desktops need tigervnc-standalone-server openbox .* its user dev has no root access or passwordless sudo/);
  assert.match(error.hint ?? "", /^Install them in the box: sudo apt-get install -y tigervnc-standalone-server openbox/);
  await rejectsGui(installer.ensureBrowser(fake.connection()), /no Chrome or Chromium in this box, and its user dev has no root access/);
  assert.equal(fake.count("desktop-install") + fake.count("browser-install"), 0);
});

test("an unsupported package manager or architecture is refused clearly", async () => {
  const pacman = box();
  pacman.pm = "pacman";
  await rejectsGui(createBoxGuiInstaller().ensureDesktop(pacman.connection()), /only with apt or dnf\/yum, and this box has pacman/);
  await rejectsGui(createBoxGuiInstaller().ensureBrowser(pacman.connection()), /only with apt or dnf\/yum \(this box has pacman\)/);
  const arm32 = box();
  arm32.machine = "armv7l";
  await rejectsGui(createBoxGuiInstaller().ensureBrowser(arm32.connection()), /Google Chrome has no Linux build for armv7l boxes/);
});

test("a failed install is reported with its log tail and not memoized", async () => {
  const fake = box();
  fake.answers["desktop-install"] = [{ stdout: "Installing the desktop packages: tigervnc-standalone-server openbox\nE: Unable to locate package openbox\nCould not install the desktop packages.\n", code: 3 }];
  const warnings: string[] = [];
  const installer = createBoxGuiInstaller({ logger: { warn: (message) => warnings.push(message) } });
  const error = await rejectsGui(installer.ensureDesktop(fake.connection()), /^Installing the desktop packages in the box failed \(exit 3\):\n[\s\S]*E: Unable to locate package openbox/);
  assert.match(error.hint ?? "", /sudo apt-get install -y tigervnc-standalone-server openbox/);
  assert.deepEqual(warnings, ["box desktop install failed"]);
  const status = await installer.ensureDesktop(fake.connection());
  assert.equal(status.available, true, "the next call retries");
  assert.equal(fake.count("desktop-install"), 2);
});

test("concurrent callers share one run; a late joiner gets the earlier progress lines", async () => {
  const fake = box();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const installStarted = new Promise<void>((resolve) => (started = resolve));
  fake.answers["browser-install"] = [{ hang: true }];
  fake.onInstall = (call) => {
    started();
    void held.then(() => {
      fake.chrome = true;
      call.proc.finish("Google Chrome is installed.\n", 0);
    });
  };
  const installer = createBoxGuiInstaller();
  const first: string[] = [];
  const late: string[] = [];
  const a = installer.ensureBrowser(fake.connection(), { onProgress: (line) => first.push(line) });
  await installStarted;
  const b = installer.ensureBrowser(fake.connection(), { onProgress: (line) => late.push(line) });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.equal(ra.noSandbox, true, "root runs Chrome without its sandbox");
  assert.equal(fake.count("browser-install"), 1);
  assert.equal(late[0], first[0], "the joiner saw the run from its first line");
  assert.deepEqual(late, first);
});

test("one caller's abort leaves the others waiting; the last waiter's abort stops the run", async () => {
  const fake = box();
  fake.answers["desktop-install"] = [{ hang: true }];
  let started!: (call: Call) => void;
  const installStarted = new Promise<Call>((resolve) => (started = resolve));
  fake.onInstall = (call) => started(call);
  const installer = createBoxGuiInstaller();
  const one = new AbortController();
  const two = new AbortController();
  const a = installer.ensureDesktop(fake.connection(), { signal: one.signal });
  const b = installer.ensureDesktop(fake.connection(), { signal: two.signal });
  const install = await installStarted;
  one.abort(new Error("tab one closed"));
  await assert.rejects(a, /tab one closed/);
  assert.equal(install.proc.killed, false, "another caller still waits");
  two.abort(new Error("tab two closed"));
  await assert.rejects(b, /tab two closed/);
  assert.equal(install.proc.killed, true, "nobody waits any more: the install is stopped");

  // The abandoned run is not memoized: the next caller starts a fresh one.
  const status = await installer.ensureDesktop(fake.connection());
  assert.equal(status.available, true);
  assert.equal(fake.count("desktop-install"), 2);
});

test("an already-aborted signal rejects without starting anything", async () => {
  const fake = box();
  await assert.rejects(createBoxGuiInstaller().ensureBrowser(fake.connection(), { signal: AbortSignal.abort(new Error("gone")) }), /gone/);
  assert.equal(fake.calls.length, 0);
});

test("forget stops a run in flight", async () => {
  const fake = box();
  fake.answers["browser-install"] = [{ hang: true }];
  let started!: (call: Call) => void;
  const installStarted = new Promise<Call>((resolve) => (started = resolve));
  fake.onInstall = (call) => started(call);
  const installer = createBoxGuiInstaller();
  const pending = installer.ensureBrowser(fake.connection());
  const install = await installStarted;
  installer.forget("box1");
  await rejectsGui(pending, /The box was removed\./);
  assert.equal(install.proc.killed, true);
});

test("a command past its deadline becomes a refusal saying so", async () => {
  const fake = box();
  fake.answers["desktop-install"] = [{ hang: true }];
  const installer = createBoxGuiInstaller({ timeouts: { installMs: 20 } });
  await rejectsGui(installer.ensureDesktop(fake.connection()), /^Installing the desktop packages did not finish within 1 s\.$/);
});

test("a disconnected box is refused before anything runs", async () => {
  const fake = box();
  fake.connected = false;
  await rejectsGui(createBoxGuiInstaller().ensureDesktop(fake.connection()), /^The box is not connected right now\.$/);
  await rejectsGui(createBoxGuiInstaller().desktopStatus(fake.connection()), /not connected/);
  assert.equal(fake.calls.length, 0);
});

test("Chrome's sandbox: blocked for a normal user means noSandbox; never trying in a container", async () => {
  const blocked = box({ user: "dev", isRoot: false });
  blocked.uid = 1000;
  blocked.chrome = true;
  blocked.sandbox = "fail";
  const lines: string[] = [];
  assert.equal((await createBoxGuiInstaller().ensureBrowser(blocked.connection(), { onProgress: (line) => lines.push(line) })).noSandbox, true);
  assert.ok(lines.some((line) => line.includes("user namespaces are blocked")));

  const container = box({ user: "dev", isRoot: false, container: true });
  container.uid = 1000;
  container.chrome = true;
  assert.equal((await createBoxGuiInstaller().ensureBrowser(container.connection())).noSandbox, true);
  assert.equal(container.calls.find((call) => call.kind === "chrome-start")!.args.at(-1), "0");
});

test("Chrome that does not start at all is refused with its log", async () => {
  const fake = box();
  fake.chrome = true;
  fake.noSandbox = "fail";
  await rejectsGui(createBoxGuiInstaller().ensureBrowser(fake.connection()), /^Chrome is installed at \/opt\/google\/chrome\/chrome but does not start in this box:\nnosandbox-log: Trace\/breakpoint trap$/);
});

test("ensureBrowser installs Chrome when the box has none, then checks it", async () => {
  const fake = box();
  const runtime = await createBoxGuiInstaller().ensureBrowser(fake.connection());
  assert.equal(runtime.chromiumPath, "/opt/google/chrome/chrome");
  assert.deepEqual(fake.calls.map((call) => call.kind), ["probe", "browser-install", "probe", "chrome-start"]);
});

test("ensureBrowser adds CJK and emoji fonts the box lacks before checking Chrome; never without root", async () => {
  const fake = box();
  fake.chrome = true;
  fake.fonts = false;
  const lines: string[] = [];
  await createBoxGuiInstaller().ensureBrowser(fake.connection(), { onProgress: (line) => lines.push(line) });
  assert.deepEqual(fake.calls.map((call) => call.kind), ["probe", "fonts-install", "chrome-start"]);
  assert.ok(lines.includes("Adding CJK and emoji fonts for the browser"), lines.join("\n"));
  const script = fake.calls[1]!.args[fake.calls[1]!.args.indexOf("-c") + 1]!;
  assert.match(script, /fonts-noto-cjk/);
  assert.match(script, /fonts-noto-color-emoji/);

  const user = box({ user: "dev", isRoot: false });
  user.uid = 1000;
  user.chrome = true;
  user.fonts = false;
  await createBoxGuiInstaller().ensureBrowser(user.connection());
  assert.deepEqual(user.calls.map((call) => call.kind), ["probe", "chrome-start"]);
});

test("fonts that cannot be installed cost a progress line, not the browser", async () => {
  const fake = box();
  fake.chrome = true;
  fake.fonts = false;
  fake.answers["fonts-install"] = [{ code: 100, stdout: "E: Unable to locate package fonts-noto-cjk\n" }];
  const lines: string[] = [];
  const runtime = await createBoxGuiInstaller().ensureBrowser(fake.connection(), { onProgress: (line) => lines.push(line) });
  assert.equal(runtime.chromiumPath, "/opt/google/chrome/chrome");
  assert.ok(lines.includes("Could not add the CJK and emoji fonts; such text may show as boxes."), lines.join("\n"));
});
