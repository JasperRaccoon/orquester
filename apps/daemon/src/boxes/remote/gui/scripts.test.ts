import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  browserFontsScript,
  browserInstallScript,
  chromeStartScript,
  desktopInstallScript,
  parseChromeStart
} from "./scripts.ts";

const isRoot = process.getuid?.() === 0;

function syntaxOk(script: string): void {
  execFileSync("/bin/sh", ["-n", "-c", script]);
}

/** Run `script` with stub commands first on PATH; resolves with the exit code and output. */
function runWithStubs(script: string, bin: string, env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", script, "sh", ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

/**
 * A fake package manager `name`: logs each call to $LOG; `update` marks the lists fresh; an
 * install fails until then (apt only, like stale lists), or when it names a package in $FAIL.
 */
async function stubBin(t: TestContext, manager: "apt-get" | "dnf"): Promise<{ bin: string; log: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "orq-gui-stubs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.log");
  const needsUpdate = manager === "apt-get" ? 1 : 0;
  await writeFile(
    join(dir, manager),
    [
      "#!/bin/sh",
      `echo "${manager} $*" >> "$LOG"`,
      'echo "noninteractive=$DEBIAN_FRONTEND" >> "$LOG"',
      "cmd=; for a in \"$@\"; do case $a in update | install) cmd=$a ;; esac; done",
      'if [ "$cmd" = update ]; then : > "$STATE/updated"; exit 0; fi',
      `if [ ${needsUpdate} = 1 ] && [ ! -f "$STATE/updated" ]; then echo "E: Unable to locate package"; exit 100; fi`,
      'for a in "$@"; do case " $FAIL " in *" $a "*) echo "E: Unable to locate package $a"; exit 100 ;; esac; done',
      "exit 0"
    ].join("\n"),
    { mode: 0o755 }
  );
  await writeFile(join(dir, "dpkg"), '#!/bin/sh\necho "dpkg $*" >> "$LOG"\n[ "$1" = --print-architecture ] && echo amd64\nexit 0\n', { mode: 0o755 });
  await writeFile(join(dir, "dbus-uuidgen"), '#!/bin/sh\necho "dbus-uuidgen $*" >> "$LOG"\nexit 0\n', { mode: 0o755 });
  return { bin: dir, log, env: { LOG: log, STATE: dir } };
}

const PLAN = {
  required: [["tigervnc-standalone-server"], ["openbox"]],
  optional: [["pulseaudio"], ["ffmpeg"], ["xterm"]]
};

test("generated scripts are valid POSIX sh for every package manager", () => {
  for (const manager of ["apt", "dnf", "yum"] as const) {
    syntaxOk(desktopInstallScript({ manager, ...PLAN }));
    syntaxOk(desktopInstallScript({ manager, required: [], optional: [] }));
    syntaxOk(browserInstallScript(manager));
  }
  syntaxOk(chromeStartScript());
});

test("the Chrome install names Google's signed repository and distro keyring paths", () => {
  const apt = browserInstallScript("apt");
  assert.match(apt, /https:\/\/dl\.google\.com\/linux\/linux_signing_key\.pub/);
  assert.match(apt, /'\/etc\/apt\/sources\.list\.d\/google-chrome\.list'/);
  assert.match(apt, /--proto '=https'/);
  assert.ok(apt.includes("google-chrome-stable"));
  // Chrome's postinst takes the repository over; a later run reuses it, and our key goes once unused.
  assert.ok(apt.includes("/etc/apt/sources.list.d/google-chrome.sources"));
  assert.ok(apt.includes("/usr/share/keyrings/google-chrome.gpg"));
  const rpm = browserInstallScript("dnf");
  assert.match(rpm, /gpgcheck=1/);
  assert.match(rpm, /baseurl=https:\/\/dl\.google\.com\/linux\/chrome\/rpm\/stable\/\$basearch/);
  assert.match(rpm, /gpgkey=https:\/\/dl\.google\.com\/linux\/linux_signing_key\.pub/);
});

test("apt: stale lists are refreshed and the install retried; a missing optional package is skipped alone", async (t) => {
  const stubs = await stubBin(t, "apt-get");
  const { code, out } = await runWithStubs(desktopInstallScript({ manager: "apt", ...PLAN }), stubs.bin, { ...stubs.env, FAIL: "ffmpeg" });
  assert.equal(code, 0, out);
  const calls = await readFile(stubs.log, "utf8");
  assert.match(calls, /^noninteractive=noninteractive$/m);
  assert.match(calls, /^apt-get .* -o DPkg::Lock::Timeout=600 /m);
  assert.match(calls, /^dpkg --configure -a$/m);
  assert.match(calls, /apt-get .* update/);
  assert.match(calls, /apt-get .*install --no-install-recommends tigervnc-standalone-server openbox$/m);
  // The optional batch failed on ffmpeg, so each package went on its own.
  assert.match(calls, /install --no-install-recommends pulseaudio$/m);
  assert.match(calls, /install --no-install-recommends xterm$/m);
  assert.match(out, /Skipped ffmpeg: it cannot be installed here\./);
  assert.match(out, /Desktop packages are installed\./);
});

test("apt: a required package that cannot be installed fails the script with exit 3", async (t) => {
  const stubs = await stubBin(t, "apt-get");
  const { code, out } = await runWithStubs(desktopInstallScript({ manager: "apt", ...PLAN }), stubs.bin, { ...stubs.env, FAIL: "openbox" });
  assert.equal(code, 3);
  assert.match(out, /Could not install the desktop packages\./);
  assert.doesNotMatch(out, /Desktop packages are installed/);
});

test("dnf: an optional package falls back to its alternative name", async (t) => {
  const stubs = await stubBin(t, "dnf");
  const plan = { manager: "dnf" as const, required: [["openbox"]], optional: [["ffmpeg", "ffmpeg-free"], ["xterm"]] };
  const { code, out } = await runWithStubs(desktopInstallScript(plan), stubs.bin, { ...stubs.env, FAIL: "ffmpeg" });
  assert.equal(code, 0, out);
  const calls = await readFile(stubs.log, "utf8");
  assert.match(calls, /dnf install -y --setopt=install_weak_deps=False ffmpeg-free$/m);
  assert.doesNotMatch(out, /Skipped/);
});

test("Chrome start check: sandbox first for a normal user, --no-sandbox when it fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-gui-chrome-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chrome = join(dir, "chrome");
  // Starts only with --no-sandbox; otherwise fails the way a blocked sandbox does.
  await writeFile(
    chrome,
    [
      "#!/bin/sh",
      'for a in "$@"; do [ "$a" = --no-sandbox ] && { echo "<html><body><p>orq-gui-ok</p></body></html>"; exit 0; }; done',
      'echo "FATAL:zygote_host_impl_linux.cc No usable sandbox!" >&2',
      "exit 1"
    ].join("\n"),
    { mode: 0o755 }
  );
  const withSandbox = await runWithStubs(chromeStartScript(), dir, {}, [chrome, "1"]);
  const parsed = parseChromeStart(withSandbox.out);
  if (isRoot) {
    assert.equal(parsed.sandbox, null, "root never tries the sandbox");
  } else {
    assert.equal(parsed.sandbox, false);
    assert.ok(parsed.log.some((line) => line.includes("No usable sandbox")), withSandbox.out);
  }
  assert.equal(parsed.noSandbox, true);

  const skipped = parseChromeStart((await runWithStubs(chromeStartScript(), dir, {}, [chrome, "0"])).out);
  assert.deepEqual(skipped, { sandbox: null, noSandbox: true, log: [] });
});

test("parseChromeStart reads both attempts and their logs", () => {
  assert.deepEqual(parseChromeStart("sandbox=ok\n"), { sandbox: true, noSandbox: null, log: [] });
  assert.deepEqual(parseChromeStart("sandbox=fail\nsandbox-log: boom\nnosandbox=fail\nnosandbox-log: bang\nnoise\n"), {
    sandbox: false,
    noSandbox: false,
    log: ["sandbox-log: boom", "nosandbox-log: bang"]
  });
});

test("browser fonts: a font the distro lacks is skipped alone and the script still succeeds", async (t) => {
  const script = browserFontsScript("apt", [["fonts-noto-cjk"], ["fonts-noto-color-emoji"]]);
  syntaxOk(script);
  const stubs = await stubBin(t, "apt-get");
  const { code, out } = await runWithStubs(script, stubs.bin, { ...stubs.env, FAIL: "fonts-noto-cjk" });
  assert.equal(code, 0, out);
  const calls = await readFile(stubs.log, "utf8");
  assert.match(calls, /install --no-install-recommends fonts-noto-color-emoji$/m);
  assert.match(out, /Skipped fonts-noto-cjk: it cannot be installed here\./);
  assert.match(out, /Fonts are installed\./);
});
