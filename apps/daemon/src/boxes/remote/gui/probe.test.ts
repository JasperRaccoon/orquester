import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  boxDesktopInstallHint,
  boxDesktopInstallsOnOpen,
  browserFontChoices,
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

// What the probe printed on a fresh Hetzner Ubuntu 24.04 box with the desktop packages installed (trimmed).
const INSTALLED = `os-id=ubuntu
os-like=debian
os-version=24.04
machine=x86_64
uid=0
sudo=0
pm=apt-get
passwd=1
tool:Xvnc=/usr/bin/Xvnc
tool:openbox=/usr/bin/openbox
tool:dbus-daemon=/usr/bin/dbus-daemon
tool:tmux=/usr/bin/tmux
tool:pulseaudio=/usr/bin/pulseaudio
tool:pactl=/usr/bin/pactl
tool:ffmpeg=/usr/bin/ffmpeg
tool:xcompmgr=/usr/bin/xcompmgr
tool:xterm=/usr/bin/xterm
tmux-version=tmux 3.4
>>> ffmpeg-devices
Devices:
 D. = Demuxing supported
 .E = Muxing supported
 --
 DE alsa            ALSA audio output
 DE pulse           Pulse audio output
<<< ffmpeg-devices
>>> ffmpeg-encoders
Encoders:
 A....D libopus              libopus Opus (codec opus)
<<< ffmpeg-encoders
render=0
mesa=1
machine-id=1
fonts=1
chrome=/opt/google/chrome/chrome
chrome-version=Google Chrome 156.0.8078.47
`;

// The same box before anything was installed (Ubuntu's cloud image has tmux and dbus).
const FRESH = `os-id=ubuntu
os-like=debian
os-version=24.04
machine=aarch64
uid=1000
sudo=1
pm=apt-get
passwd=1
tool:Xvnc=
tool:openbox=
tool:dbus-daemon=/usr/bin/dbus-daemon
tool:tmux=/usr/bin/tmux
tool:pulseaudio=
tool:pactl=
tool:ffmpeg=
tool:xcompmgr=
tool:xterm=
tmux-version=tmux 3.4
render=0
mesa=0
machine-id=1
fonts=0
chrome-skip=/usr/bin/chromium-browser
`;

function facts(text: string, overrides: Partial<BoxGuiFacts> = {}): BoxGuiFacts {
  return { ...parseGuiProbe(text), ...overrides };
}

test("parses the probe's key=value lines and ffmpeg sections", () => {
  const parsed = parseGuiProbe(INSTALLED);
  assert.equal(parsed.osId, "ubuntu");
  assert.deepEqual(parsed.osLike, ["debian"]);
  assert.equal(parsed.osVersion, "24.04");
  assert.equal(parsed.machine, "x86_64");
  assert.equal(parsed.uid, 0);
  assert.equal(parsed.packageCommand, "apt-get");
  assert.equal(parsed.tools.Xvnc, "/usr/bin/Xvnc");
  assert.equal(parsed.tmuxVersion, "tmux 3.4");
  assert.match(parsed.ffmpegDevices, /^ DE pulse/m);
  assert.match(parsed.ffmpegEncoders, /libopus/);
  assert.deepEqual(parsed.chrome, { path: "/opt/google/chrome/chrome", version: "Google Chrome 156.0.8078.47" });
  assert.deepEqual(parsed.chromeSkipped, []);

  const fresh = parseGuiProbe(FRESH);
  assert.equal(fresh.tools.Xvnc, null);
  assert.equal(fresh.sudo, true);
  assert.equal(fresh.chrome, null);
  assert.deepEqual(fresh.chromeSkipped, ["/usr/bin/chromium-browser"]);
});

test("only absolute tool paths count; unknown keys and garbage are ignored", () => {
  const parsed = parseGuiProbe("tool:tmux=tmux\nuid=abc\nnonsense\n=x\nfoo=bar\nchrome=chromium\n");
  assert.equal(parsed.tools.tmux, null);
  assert.equal(parsed.uid, null);
  assert.equal(parsed.chrome, null);
  assert.equal(parsed.packageCommand, null);
});

test("a section line that looks like key=value stays in its section", () => {
  const parsed = parseGuiProbe(">>> ffmpeg-encoders\nuid=0\n<<< ffmpeg-encoders\n");
  assert.equal(parsed.uid, null);
  assert.equal(parsed.ffmpegEncoders, "uid=0");
});

test("the box status follows the host's rules", () => {
  const { status, missingPackages } = evaluateBoxDesktop(facts(INSTALLED));
  assert.equal(status.available, true);
  assert.equal(status.audioAvailable, true);
  assert.equal(status.tmuxUsable, true);
  assert.deepEqual(missingPackages, []);
  assert.deepEqual(status.warnings, []);

  const fresh = evaluateBoxDesktop(facts(FRESH));
  assert.equal(fresh.status.available, false);
  assert.deepEqual(fresh.missingPackages.sort(), ["ffmpeg", "libgl1-mesa-dri", "openbox", "pulseaudio", "pulseaudio-utils", "tigervnc-standalone-server", "xcompmgr"]);

  const oldTmux = evaluateBoxDesktop(facts(INSTALLED, { tmuxVersion: "tmux 3.1c" }));
  assert.equal(oldTmux.status.available, false);
  assert.ok(oldTmux.status.warnings.some((warning) => warning.startsWith("tmux is older than 3.2")));

  const noPasswd = evaluateBoxDesktop(facts(INSTALLED, { passwdEntry: false, machineId: false }));
  assert.ok(noPasswd.status.warnings.includes("The box user has no passwd entry; some apps may fail to start."));
  assert.ok(noPasswd.status.warnings.some((warning) => warning.startsWith("/etc/machine-id")));

  const noOpus = evaluateBoxDesktop(facts(INSTALLED, { ffmpegEncoders: "" }));
  assert.equal(noOpus.status.audioAvailable, false);
  assert.equal(noOpus.status.ffmpegOpus, false);
});

test("the install plan names packages per package manager, plus a terminal and fonts", () => {
  const fresh = facts(FRESH);
  const { missingPackages } = evaluateBoxDesktop(fresh);
  const apt = desktopInstallPlan(fresh, missingPackages, "apt");
  assert.deepEqual(apt.required, [["tigervnc-standalone-server"], ["openbox"]]);
  assert.deepEqual(apt.optional, [["libgl1-mesa-dri"], ["pulseaudio"], ["pulseaudio-utils"], ["ffmpeg"], ["xcompmgr"], ["xterm"], ["fonts-dejavu-core"]]);

  const dnf = desktopInstallPlan(fresh, missingPackages, "dnf");
  assert.deepEqual(dnf.required, [["tigervnc-server-minimal"], ["openbox"]]);
  assert.deepEqual(dnf.optional, [["mesa-dri-drivers"], ["pulseaudio"], ["pulseaudio-utils"], ["ffmpeg", "ffmpeg-free"], ["xcompmgr"], ["xterm"], ["dejavu-sans-fonts"]]);
  assert.equal(manualInstallCommand("dnf", dnf.required), "sudo dnf install -y tigervnc-server-minimal openbox");

  const complete = facts(INSTALLED);
  assert.deepEqual(desktopInstallPlan(complete, [], "apt").missing, []);
});

test("the install hint says Orquester installs, or why it cannot", () => {
  const fresh = facts(FRESH);
  const { missingPackages } = evaluateBoxDesktop(fresh);
  assert.equal(
    boxDesktopInstallHint(fresh, missingPackages, "dev"),
    "Orquester installs tigervnc-standalone-server openbox libgl1-mesa-dri pulseaudio pulseaudio-utils ffmpeg xcompmgr xterm fonts-dejavu-core in the box when a desktop opens."
  );
  assert.match(
    boxDesktopInstallHint({ ...fresh, sudo: false }, missingPackages, "dev") ?? "",
    /^Orquester cannot install tigervnc-standalone-server .*: the box user dev has no root access or passwordless sudo\. Install them in the box \(sudo apt-get install -y tigervnc-standalone-server openbox /
  );
  assert.match(boxDesktopInstallHint({ ...fresh, packageCommand: "pacman" }, missingPackages, "dev") ?? "", /only with apt or dnf\/yum/);
  assert.equal(boxDesktopInstallHint(facts(INSTALLED), [], "root"), null);
  assert.equal(nonLinuxDesktopStatus().installHint, "Desktops run only in Linux VMs.");
  assert.equal(nonLinuxDesktopStatus().available, false);
});

test("a desktop installs what is missing by itself only with a package manager and root or sudo", () => {
  const fresh = facts(FRESH);
  const { missingPackages } = evaluateBoxDesktop(fresh);
  assert.equal(boxDesktopInstallsOnOpen(fresh, missingPackages), true);
  assert.equal(boxDesktopInstallsOnOpen({ ...fresh, sudo: false }, missingPackages), false);
  assert.equal(boxDesktopInstallsOnOpen({ ...fresh, packageCommand: "pacman" }, missingPackages), false);
  assert.equal(boxDesktopInstallsOnOpen(facts(INSTALLED), []), false);
});

test("package managers and Chrome architectures", () => {
  assert.equal(packageManagerOf({ packageCommand: "apt-get" }), "apt");
  assert.equal(packageManagerOf({ packageCommand: "dnf" }), "dnf");
  assert.equal(packageManagerOf({ packageCommand: "yum" }), "yum");
  assert.equal(packageManagerOf({ packageCommand: "apk" }), null);
  assert.equal(packageManagerOf({ packageCommand: null }), null);
  assert.equal(chromeArch("x86_64"), "amd64");
  assert.equal(chromeArch("aarch64"), "arm64");
  assert.equal(chromeArch("armv7l"), null);
});

test("every probe variant is valid POSIX sh", () => {
  for (const parts of [
    { desktop: true, browser: true },
    { desktop: true, browser: false },
    { desktop: false, browser: true }
  ]) {
    execFileSync("/bin/sh", ["-n", "-c", guiProbeScript(parts)]);
  }
  assert.doesNotMatch(guiProbeScript({ desktop: false, browser: true }), /ffmpeg/);
  assert.doesNotMatch(guiProbeScript({ desktop: true, browser: false }), /chrome/);
});

test("the browser probe reads the CJK and emoji fonts; only missing ones are installed, per package manager", () => {
  const facts = parseGuiProbe("os-id=ubuntu\nuid=0\npm=apt-get\ncjk-fonts=0\nemoji-font=1\n");
  assert.equal(facts.cjkFonts, false);
  assert.equal(facts.emojiFont, true);
  assert.deepEqual(browserFontChoices(facts, "apt"), [["fonts-noto-cjk"]]);
  assert.deepEqual(browserFontChoices({ cjkFonts: false, emojiFont: false }, "dnf"), [
    ["google-noto-sans-cjk-fonts", "google-noto-sans-cjk-ttc-fonts"],
    ["google-noto-color-emoji-fonts", "google-noto-emoji-color-fonts"]
  ]);
  assert.deepEqual(browserFontChoices({ cjkFonts: true, emojiFont: true }, "apt"), []);
  execFileSync("/bin/sh", ["-n", "-c", guiProbeScript({ desktop: false, browser: true })]);
});
