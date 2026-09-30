import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { DesktopHostStatus, DesktopHostTool } from "@orquester/api";
import { sessionPath, tmuxAvailable, tmuxVersionOk } from "../tmux.ts";

// Host prerequisites for desktops (desktop spec §4): which tools resolve,
// whether ffmpeg can capture PulseAudio and encode Opus, GL and system checks,
// and one apt install hint for whatever is missing.

interface ToolSpec {
  name: string;
  /** The Ubuntu package that provides it (the install hint). */
  pkg: string;
  required: boolean;
}

const TOOLS: ToolSpec[] = [
  { name: "Xvnc", pkg: "tigervnc-standalone-server", required: true },
  { name: "openbox", pkg: "openbox", required: true },
  { name: "dbus-daemon", pkg: "dbus-x11", required: true },
  { name: "tmux", pkg: "tmux", required: true },
  { name: "pulseaudio", pkg: "pulseaudio", required: false },
  { name: "pactl", pkg: "pulseaudio-utils", required: false },
  { name: "ffmpeg", pkg: "ffmpeg", required: false }
];

/** Package order in the hint (the spec's list). */
const PACKAGE_ORDER = [
  "tigervnc-standalone-server",
  "openbox",
  "pulseaudio",
  "pulseaudio-utils",
  "dbus-x11",
  "libgl1-mesa-dri",
  "tmux",
  "ffmpeg"
];

/**
 * First executable `name` on `path`: the registry's resolveBin probe (X_OK on
 * each PATH dir). The default PATH is the sessions' one — the daemon's own is
 * narrow under systemd, and the host script runs with the session PATH.
 */
export function resolveTool(name: string, path: string = sessionPath()): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Whether `ffmpeg -hide_banner -devices` lists `pulse` as an input (demuxing)
 * device. Rows look like ` DE pulse           Pulse audio output`: a space,
 * the D and E flag columns, a space, then the name (or a comma list).
 */
export function parseFfmpegPulseInput(devicesOutput: string): boolean {
  for (const line of devicesOutput.split("\n")) {
    const match = /^ ([D. ])([E. ]) (\S+)/.exec(line);
    if (match && match[1] === "D" && match[3].split(",").includes("pulse")) {
      return true;
    }
  }
  return false;
}

/** Whether `ffmpeg -hide_banner -encoders` lists `libopus` (rows: ` A....D libopus  …`). */
export function parseFfmpegOpusEncoder(encodersOutput: string): boolean {
  return encodersOutput.split("\n").some((line) => /^ [A-Z.]{6} libopus(\s|$)/.test(line));
}

/** The apt command for the missing packages in the spec's order, or null when nothing is missing. */
export function buildInstallHint(missingPackages: Iterable<string>): string | null {
  const missing = new Set(missingPackages);
  if (missing.size === 0) return null;
  const ordered = [
    ...PACKAGE_ORDER.filter((pkg) => missing.has(pkg)),
    ...[...missing].filter((pkg) => !PACKAGE_ORDER.includes(pkg))
  ];
  return `sudo apt-get install -y ${ordered.join(" ")}`;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? "" : String(stdout ?? ""));
    });
  });
}

/** A `/dev/dri/renderD*` node exists (hardware GL is possible; else apps get software GL). */
export function hasRenderNode(): boolean {
  try {
    return readdirSync("/dev/dri").some((name) => name.startsWith("renderD"));
  } catch {
    return false;
  }
}

/** Mesa's software rasterizer (llvmpipe) from libgl1-mesa-dri, in any multiarch lib dir. */
function hasMesaDri(): boolean {
  for (const lib of ["/usr/lib", "/usr/lib64"]) {
    let entries: string[];
    try {
      entries = readdirSync(lib);
    } catch {
      continue;
    }
    for (const dir of ["dri", ...entries.map((entry) => join(entry, "dri"))]) {
      try {
        accessSync(join(lib, dir, "swrast_dri.so"), constants.R_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

function machineIdOk(): boolean {
  try {
    return readFileSync("/etc/machine-id", "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function passwdEntryOk(): boolean {
  try {
    userInfo();
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the host once per call for the tools (installing a package lights
 * desktops up without a restart), and once per daemon run for the ffmpeg
 * capability probe and the tmux version (both spawn a process).
 */
export class DesktopHostProbe {
  private ffmpegCaps: { path: string; caps: Promise<{ pulse: boolean; opus: boolean }> } | null = null;
  private tmuxOk: boolean | null = null;

  constructor(private readonly options: { path?: () => string } = {}) {}

  async status(): Promise<DesktopHostStatus> {
    const path = this.options.path?.() ?? sessionPath();
    const tools: DesktopHostTool[] = TOOLS.map((tool) => ({
      name: tool.name,
      path: resolveTool(tool.name, path),
      required: tool.required
    }));
    const found = (name: string) => tools.find((tool) => tool.name === name)?.path ?? null;
    const missing = new Set(TOOLS.filter((tool) => found(tool.name) === null).map((tool) => tool.pkg));

    const ffmpeg = found("ffmpeg");
    const caps = ffmpeg ? await this.ffmpegCapabilities(ffmpeg) : { pulse: false, opus: false };
    if (this.tmuxOk === null) {
      this.tmuxOk = tmuxAvailable() && tmuxVersionOk();
    }
    const tmuxUsable = found("tmux") !== null && this.tmuxOk;

    const warnings: string[] = [];
    const renderNode = hasRenderNode();
    if (!hasMesaDri()) {
      missing.add("libgl1-mesa-dri");
      warnings.push("Mesa's software OpenGL driver (libgl1-mesa-dri) is not installed; OpenGL apps will fail.");
    }
    if (found("tmux") !== null && !this.tmuxOk) {
      warnings.push("tmux is older than 3.2; desktops need tmux 3.2 or newer to survive daemon restarts.");
    }
    if (ffmpeg && !caps.pulse) {
      warnings.push("ffmpeg has no PulseAudio input device; desktops run without sound.");
    }
    if (ffmpeg && !caps.opus) {
      warnings.push("ffmpeg has no libopus encoder; desktops run without sound.");
    }
    if (!machineIdOk()) {
      warnings.push("/etc/machine-id is missing or empty; D-Bus and PulseAudio may refuse to start.");
    }
    if (!passwdEntryOk()) {
      warnings.push("The daemon's user has no passwd entry; some apps may fail to start.");
    }

    const available = TOOLS.every((tool) => !tool.required || found(tool.name) !== null) && tmuxUsable;
    const audioAvailable = found("pulseaudio") !== null && caps.pulse && caps.opus;
    return {
      available,
      audioAvailable,
      tools,
      ffmpegPulse: caps.pulse,
      ffmpegOpus: caps.opus,
      renderNode,
      tmuxUsable,
      warnings,
      installHint: buildInstallHint(missing)
    };
  }

  private ffmpegCapabilities(ffmpeg: string): Promise<{ pulse: boolean; opus: boolean }> {
    if (this.ffmpegCaps?.path !== ffmpeg) {
      this.ffmpegCaps = {
        path: ffmpeg,
        caps: Promise.all([
          run(ffmpeg, ["-hide_banner", "-devices"]),
          run(ffmpeg, ["-hide_banner", "-encoders"])
        ]).then(([devices, encoders]) => ({
          pulse: parseFfmpegPulseInput(devices),
          opus: parseFfmpegOpusEncoder(encoders)
        }))
      };
    }
    return this.ffmpegCaps.caps;
  }
}
