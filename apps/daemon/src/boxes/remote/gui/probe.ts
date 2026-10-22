/**
 * What a Linux box has for the Browser and Desktop tabs, read by one POSIX shell script run in the
 * box (`key=value` lines, plus `>>> name` … `<<< name` sections for ffmpeg's listings), and the
 * desktop status computed from it by the host's own rules (`evaluateDesktopHost`). Pure: the
 * installer runs the script and hands its stdout to {@link parseGuiProbe}.
 */

import type { DesktopHostStatus } from "@orquester/api";

import {
  DESKTOP_TOOLS,
  evaluateDesktopHost,
  parseFfmpegOpusEncoder,
  parseFfmpegPulseInput,
  tmuxVersionOutputOk
} from "../../../desktops/host-status.ts";

/** Package managers the installer can drive, by the command the probe found. */
export type BoxPackageManager = "apt" | "dnf" | "yum";

export interface BoxGuiFacts {
  /** `/etc/os-release` ID, ID_LIKE (split) and VERSION_ID; empty when unknown. */
  osId: string;
  osLike: string[];
  osVersion: string;
  /** `uname -m`: "x86_64", "aarch64"… */
  machine: string;
  /** Effective uid in the box; null when unreadable. */
  uid: number | null;
  /** Passwordless sudo works (never set for root). */
  sudo: boolean;
  /** The first package manager command found (`apt-get`, `dnf`, `yum`, `zypper`, `pacman`, `apk`), or null. */
  packageCommand: string | null;
  passwdEntry: boolean;
  /** Desktop part only (empty otherwise): resolved path per tool name, null when missing. */
  tools: Record<string, string | null>;
  tmuxVersion: string | null;
  ffmpegDevices: string;
  ffmpegEncoders: string;
  renderNode: boolean;
  mesaDri: boolean;
  machineId: boolean;
  /** At least one TrueType/OpenType/PCF font is installed. */
  fonts: boolean;
  /** Browser part only: the first usable non-snap Chrome/Chromium and its `--version`. */
  chrome: { path: string; version: string } | null;
  /** Candidates passed over (snap shims, binaries that would not print a version). */
  chromeSkipped: string[];
}

/** Tools the desktop part resolves: the host's list plus a terminal to launch on a fresh desktop. */
export const GUI_PROBE_TOOLS = [...DESKTOP_TOOLS.map((tool) => tool.name), "xterm"];

/**
 * Chrome/Chromium candidates in preference order. Google's deb and rpm install `/opt/google/chrome`;
 * Debian's and Fedora's own `chromium` work too. Ubuntu's `chromium-browser` is only accepted when
 * it is not the snap transition shim (the probe skips anything resolving under /snap or a script
 * that mentions snap): snaps do not run in containers or without snapd.
 */
const CHROME_CANDIDATES = ["/opt/google/chrome/chrome", "google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

/** Extra PATH entries: `orq-agent`'s service PATH can be narrow, and sbin holds nothing we need but is harmless. */
export const PROBE_PATH = '"$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"';

/** The probe script. `desktop` adds the desktop tools and checks, `browser` the Chrome lookup. */
export function guiProbeScript(parts: { desktop: boolean; browser: boolean }): string {
  const lines = [
    `PATH=${PROBE_PATH}`,
    "LC_ALL=C",
    "export PATH LC_ALL",
    "kv() { printf '%s=%s\\n' \"$1\" \"$2\"; }",
    "if [ -r /etc/os-release ]; then",
    "  kv os-id \"$(. /etc/os-release && printf '%s' \"${ID:-}\")\"",
    "  kv os-like \"$(. /etc/os-release && printf '%s' \"${ID_LIKE:-}\")\"",
    "  kv os-version \"$(. /etc/os-release && printf '%s' \"${VERSION_ID:-}\")\"",
    "fi",
    'kv machine "$(uname -m)"',
    'kv uid "$(id -u)"',
    'if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then kv sudo 1; else kv sudo 0; fi',
    'pm=; for c in apt-get dnf yum zypper pacman apk; do if command -v "$c" >/dev/null 2>&1; then pm=$c; break; fi; done; kv pm "$pm"',
    "if id -un >/dev/null 2>&1; then kv passwd 1; else kv passwd 0; fi"
  ];
  if (parts.desktop) {
    lines.push(
      `for t in ${GUI_PROBE_TOOLS.join(" ")}; do kv "tool:$t" "$(command -v "$t" 2>/dev/null)"; done`,
      'if command -v tmux >/dev/null 2>&1; then kv tmux-version "$(tmux -V 2>/dev/null | head -n 1)"; fi',
      "if f=$(command -v ffmpeg 2>/dev/null); then",
      "  echo '>>> ffmpeg-devices'; \"$f\" -hide_banner -devices 2>/dev/null </dev/null; echo '<<< ffmpeg-devices'",
      "  echo '>>> ffmpeg-encoders'; \"$f\" -hide_banner -encoders 2>/dev/null </dev/null; echo '<<< ffmpeg-encoders'",
      "fi",
      'render=0; for n in /dev/dri/renderD*; do if [ -e "$n" ]; then render=1; break; fi; done; kv render "$render"',
      // Mesa's software rasterizer in any multiarch lib dir (host-status.ts hasMesaDri).
      'mesa=0; for f in /usr/lib/dri/swrast_dri.so /usr/lib/*/dri/swrast_dri.so /usr/lib64/dri/swrast_dri.so /usr/lib64/*/dri/swrast_dri.so; do if [ -r "$f" ]; then mesa=1; break; fi; done; kv mesa "$mesa"',
      "if grep -q '[^[:space:]]' /etc/machine-id 2>/dev/null; then kv machine-id 1; else kv machine-id 0; fi",
      "fonts=0; for d in /usr/share/fonts /usr/local/share/fonts; do",
      "  if [ -d \"$d\" ] && [ -n \"$(find \"$d\" -type f \\( -name '*.ttf' -o -name '*.otf' -o -name '*.pcf*' \\) 2>/dev/null | head -n 1)\" ]; then fonts=1; break; fi",
      'done; kv fonts "$fonts"'
    );
  }
  if (parts.browser) {
    lines.push(
      `for c in ${CHROME_CANDIDATES.join(" ")}; do`,
      '  case $c in /*) p=$c ;; *) p=$(command -v "$c" 2>/dev/null) || continue ;; esac',
      '  [ -n "$p" ] && [ -f "$p" ] && [ -x "$p" ] || continue',
      '  real=$(readlink -f "$p" 2>/dev/null) || real=$p',
      '  case $real in /snap/*) kv chrome-skip "$p"; continue ;; esac',
      "  if [ \"$(head -c 2 \"$real\" 2>/dev/null)\" = '#!' ] && grep -q snap \"$real\" 2>/dev/null; then kv chrome-skip \"$p\"; continue; fi",
      '  v=$("$p" --version 2>/dev/null </dev/null | head -n 1)',
      '  if [ -z "$v" ]; then kv chrome-skip "$p"; continue; fi',
      '  kv chrome "$p"; kv chrome-version "$v"; break',
      "done"
    );
  }
  return lines.join("\n");
}

const PACKAGE_COMMANDS: Record<string, BoxPackageManager> = { "apt-get": "apt", dnf: "dnf", yum: "yum" };

/** The package manager the installer drives for these facts, or null (none, or one it does not support). */
export function packageManagerOf(facts: Pick<BoxGuiFacts, "packageCommand">): BoxPackageManager | null {
  return facts.packageCommand === null ? null : (PACKAGE_COMMANDS[facts.packageCommand] ?? null);
}

/** Whether the installer can act as root in the box (it is root, or passwordless sudo works). */
export function canInstall(facts: Pick<BoxGuiFacts, "uid" | "sudo">): boolean {
  return facts.uid === 0 || facts.sudo;
}

export function parseGuiProbe(stdout: string): BoxGuiFacts {
  const facts: BoxGuiFacts = {
    osId: "",
    osLike: [],
    osVersion: "",
    machine: "",
    uid: null,
    sudo: false,
    packageCommand: null,
    passwdEntry: false,
    tools: {},
    tmuxVersion: null,
    ffmpegDevices: "",
    ffmpegEncoders: "",
    renderNode: false,
    mesaDri: false,
    machineId: false,
    fonts: false,
    chrome: null,
    chromeSkipped: []
  };
  const sections: Record<string, string[]> = {};
  let section: string | null = null;
  let chromePath: string | null = null;
  let chromeVersion = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (section !== null) {
      if (line === `<<< ${section}`) section = null;
      else sections[section]!.push(line);
      continue;
    }
    const open = /^>>> (\S+)$/.exec(line);
    if (open) {
      section = open[1]!;
      sections[section] = [];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key.startsWith("tool:")) {
      // `command -v` prints a bare name for builtins and functions; only absolute paths count.
      facts.tools[key.slice(5)] = value.startsWith("/") ? value : null;
      continue;
    }
    switch (key) {
      case "os-id":
        facts.osId = value.toLowerCase();
        break;
      case "os-like":
        facts.osLike = value.toLowerCase().split(/\s+/).filter(Boolean);
        break;
      case "os-version":
        facts.osVersion = value;
        break;
      case "machine":
        facts.machine = value;
        break;
      case "uid":
        facts.uid = /^\d+$/.test(value) ? Number(value) : null;
        break;
      case "sudo":
        facts.sudo = value === "1";
        break;
      case "pm":
        facts.packageCommand = value.length > 0 ? value : null;
        break;
      case "passwd":
        facts.passwdEntry = value === "1";
        break;
      case "tmux-version":
        facts.tmuxVersion = value.length > 0 ? value : null;
        break;
      case "render":
        facts.renderNode = value === "1";
        break;
      case "mesa":
        facts.mesaDri = value === "1";
        break;
      case "machine-id":
        facts.machineId = value === "1";
        break;
      case "fonts":
        facts.fonts = value === "1";
        break;
      case "chrome":
        chromePath = value.startsWith("/") ? value : null;
        break;
      case "chrome-version":
        chromeVersion = value;
        break;
      case "chrome-skip":
        facts.chromeSkipped.push(value);
        break;
    }
  }
  facts.ffmpegDevices = (sections["ffmpeg-devices"] ?? []).join("\n");
  facts.ffmpegEncoders = (sections["ffmpeg-encoders"] ?? []).join("\n");
  if (chromePath !== null) facts.chrome = { path: chromePath, version: chromeVersion };
  return facts;
}

// ---------------------------------------------------------------------------
// Desktop packages
// ---------------------------------------------------------------------------

interface DesktopPackage {
  /** The Ubuntu/Debian package (host-status.ts names, so its missing list maps here directly). */
  apt: string;
  /** Fedora/RHEL alternatives, first preferred (`ffmpeg` from RPM Fusion, else Fedora's `ffmpeg-free`). */
  rpm: readonly string[];
  /** Without it no desktop starts; the others only cost sound, OpenGL, GTK 4 popover shadows, a terminal or legible text. */
  required: boolean;
}

/** Everything a box desktop uses, in install order (the host's list plus a terminal and fonts). */
export const DESKTOP_PACKAGES: readonly DesktopPackage[] = [
  { apt: "tigervnc-standalone-server", rpm: ["tigervnc-server-minimal"], required: true },
  { apt: "openbox", rpm: ["openbox"], required: true },
  { apt: "dbus-x11", rpm: ["dbus-daemon"], required: true },
  { apt: "tmux", rpm: ["tmux"], required: true },
  { apt: "libgl1-mesa-dri", rpm: ["mesa-dri-drivers"], required: false },
  { apt: "pulseaudio", rpm: ["pulseaudio"], required: false },
  { apt: "pulseaudio-utils", rpm: ["pulseaudio-utils"], required: false },
  { apt: "ffmpeg", rpm: ["ffmpeg", "ffmpeg-free"], required: false },
  { apt: "xcompmgr", rpm: ["xcompmgr"], required: false },
  { apt: "xterm", rpm: ["xterm"], required: false },
  { apt: "fonts-dejavu-core", rpm: ["dejavu-sans-fonts"], required: false }
];

/** A package to install: its alternatives in the box's package manager naming, first preferred. */
export type PackageChoice = readonly string[];

export interface DesktopInstallPlan {
  /** Ubuntu names of everything missing (the status' rules plus the terminal and fonts). */
  missing: string[];
  required: PackageChoice[];
  optional: PackageChoice[];
}

/** The box's desktop status by the host's rules, without the install hint. */
export function evaluateBoxDesktop(facts: BoxGuiFacts): { status: Omit<DesktopHostStatus, "installHint">; missingPackages: string[] } {
  const toolPaths: Record<string, string | null> = {};
  for (const tool of DESKTOP_TOOLS) toolPaths[tool.name] = facts.tools[tool.name] ?? null;
  const ffmpeg = toolPaths.ffmpeg !== null;
  return evaluateDesktopHost(
    {
      toolPaths,
      ffmpegPulse: ffmpeg && parseFfmpegPulseInput(facts.ffmpegDevices),
      ffmpegOpus: ffmpeg && parseFfmpegOpusEncoder(facts.ffmpegEncoders),
      tmuxVersionOk: facts.tmuxVersion !== null && tmuxVersionOutputOk(facts.tmuxVersion),
      renderNode: facts.renderNode,
      mesaDri: facts.mesaDri,
      machineId: facts.machineId,
      passwdEntry: facts.passwdEntry
    },
    { userLabel: "The box user" }
  );
}

/** What to install for a desktop in this box, in the package manager's names. */
export function desktopInstallPlan(facts: BoxGuiFacts, missingPackages: readonly string[], manager: BoxPackageManager): DesktopInstallPlan {
  const missing = new Set(missingPackages);
  if ((facts.tools.xterm ?? null) === null) missing.add("xterm");
  if (!facts.fonts) missing.add("fonts-dejavu-core");
  const plan: DesktopInstallPlan = { missing: [], required: [], optional: [] };
  for (const pkg of DESKTOP_PACKAGES) {
    if (!missing.has(pkg.apt)) continue;
    plan.missing.push(pkg.apt);
    const choice = manager === "apt" ? [pkg.apt] : pkg.rpm;
    (pkg.required ? plan.required : plan.optional).push(choice);
  }
  return plan;
}

/** The one-line install command an owner would type for `choices` (first alternatives). */
export function manualInstallCommand(manager: BoxPackageManager, choices: readonly PackageChoice[]): string {
  const names = choices.map((choice) => choice[0]).filter((name): name is string => name !== undefined);
  return manager === "apt" ? `sudo apt-get install -y ${names.join(" ")}` : `sudo ${manager} install -y ${names.join(" ")}`;
}

/** The status' `installHint` for a box: what Orquester will install, or why it cannot. */
export function boxDesktopInstallHint(facts: BoxGuiFacts, missingPackages: readonly string[], user: string): string | null {
  const manager = packageManagerOf(facts);
  if (manager === null) {
    if (missingPackages.length === 0) return null;
    return `Orquester installs desktop packages only with apt or dnf/yum; install ${missingPackages.join(", ")} (Ubuntu names) in the box yourself.`;
  }
  const plan = desktopInstallPlan(facts, missingPackages, manager);
  if (plan.missing.length === 0) return null;
  const names = [...plan.required, ...plan.optional].map((choice) => choice[0]).join(" ");
  if (!canInstall(facts)) {
    return `Orquester cannot install ${names}: the box user ${user} has no root access or passwordless sudo. Install them in the box (${manualInstallCommand(manager, [...plan.required, ...plan.optional])}).`;
  }
  return `Orquester installs ${names} in the box when a desktop opens.`;
}

/** The status a non-Linux box reports: nothing found, and why. */
export function nonLinuxDesktopStatus(): DesktopHostStatus {
  return {
    available: false,
    audioAvailable: false,
    tools: DESKTOP_TOOLS.map((tool) => ({ name: tool.name, path: null, required: tool.required })),
    ffmpegPulse: false,
    ffmpegOpus: false,
    renderNode: false,
    tmuxUsable: false,
    warnings: [],
    installHint: NON_LINUX_DESKTOP
  };
}

export const NON_LINUX_DESKTOP = "Desktops run only in Linux VMs.";
export const NON_LINUX_BROWSER = "The in-box browser runs only in Linux VMs.";

/** Chrome's Linux builds (Google's deb/rpm repositories): x86-64 and arm64. */
export function chromeArch(machine: string): "amd64" | "arm64" | null {
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return null;
}
