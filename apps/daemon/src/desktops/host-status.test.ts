import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopHostProbe,
  buildInstallHint,
  parseFfmpegOpusEncoder,
  parseFfmpegPulseInput,
  resolveTool
} from "./host-status.ts";

// Captured from ffmpeg 6.1.1 on Ubuntu 24.04 (trimmed).
const DEVICES = `Devices:
 D. = Demuxing supported
 .E = Muxing supported
 --
 DE alsa            ALSA audio output
  E caca            caca (color ASCII art) output device
 D  lavfi           Libavfilter virtual input device
 DE pulse           Pulse audio output
  E sdl,sdl2        SDL2 output device
 D  x11grab         X11 screen capture, using XCB
`;

const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 A....D aac                  AAC (Advanced Audio Coding)
 A..X.D opus                 Opus
 A....D libopus              libopus Opus (codec opus)
`;

test("ffmpeg pulse input: needs the D flag on the pulse row", () => {
  assert.equal(parseFfmpegPulseInput(DEVICES), true);
  assert.equal(parseFfmpegPulseInput(DEVICES.replace(" DE pulse", "  E pulse")), false);
  assert.equal(parseFfmpegPulseInput(DEVICES.replace(" DE pulse", " DE alsa2")), false);
  assert.equal(parseFfmpegPulseInput(" D  jack,pulse   list\n"), true);
  // The legend lines never count.
  assert.equal(parseFfmpegPulseInput(" D. = Demuxing supported\n"), false);
  assert.equal(parseFfmpegPulseInput(""), false);
});

test("ffmpeg libopus encoder: the native opus encoder is not enough", () => {
  assert.equal(parseFfmpegOpusEncoder(ENCODERS), true);
  assert.equal(parseFfmpegOpusEncoder(ENCODERS.replace(/^ A....D libopus.*$/m, "")), false);
  assert.equal(parseFfmpegOpusEncoder(""), false);
});

test("install hint lists only the missing packages, in the spec's order", () => {
  assert.equal(buildInstallHint([]), null);
  assert.equal(
    buildInstallHint(["ffmpeg", "openbox", "tigervnc-standalone-server"]),
    "sudo apt-get install -y tigervnc-standalone-server openbox ffmpeg"
  );
  assert.equal(
    buildInstallHint(["tmux", "dbus-x11", "libgl1-mesa-dri", "pulseaudio-utils", "pulseaudio"]),
    "sudo apt-get install -y pulseaudio pulseaudio-utils dbus-x11 libgl1-mesa-dri tmux"
  );
});

test("resolveTool finds executables on the given PATH only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Xvnc"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(dir, "openbox"), "not executable", { mode: 0o644 });
  assert.equal(resolveTool("Xvnc", dir), join(dir, "Xvnc"));
  assert.equal(resolveTool("openbox", dir), null);
  assert.equal(resolveTool("tmux", dir), null);
});

test("a host without the tools is unavailable with an install hint", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const status = await new DesktopHostProbe({ path: () => dir }).status();
  assert.equal(status.available, false);
  assert.equal(status.audioAvailable, false);
  assert.equal(status.tmuxUsable, false);
  assert.ok(status.tools.every((tool) => tool.path === null));
  assert.match(status.installHint ?? "", /^sudo apt-get install -y tigervnc-standalone-server openbox pulseaudio /);
  assert.deepEqual(
    status.tools.filter((tool) => tool.required).map((tool) => tool.name),
    ["Xvnc", "openbox", "dbus-daemon", "tmux"]
  );
});
