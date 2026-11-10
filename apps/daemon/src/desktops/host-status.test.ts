import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_TOOLS,
  DesktopHostInstallError,
  DesktopHostProbe,
  type HostAptGet,
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
  const status = await new DesktopHostProbe({ path: () => dir, apt: fakeApt(dir, { available: false }).apt }).status();
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

test("voxl is reported as an optional tool: a voxl that cannot be checked never makes desktops unavailable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-voxl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const apt = fakeApt(dir, { available: false }).apt;
  const voxl = { available: true, version: "0.3.4", path: "/usr/local/bin/voxl" };
  assert.deepEqual((await new DesktopHostProbe({ path: () => dir, apt, voxl: async () => voxl }).status()).voxl, voxl);
  const failing = await new DesktopHostProbe({
    path: () => dir,
    apt,
    voxl: async () => {
      throw new Error("EACCES");
    }
  }).status();
  assert.equal(failing.voxl?.available, false);
  assert.match(failing.voxl?.reason ?? "", /EACCES/);
});

/** apt-get as root, faked: `install` puts every desktop tool on `dir` unless it is told to fail first. */
function fakeApt(dir: string, options: { available?: boolean; failingInstalls?: number }) {
  const calls: string[][] = [];
  let failing = options.failingInstalls ?? 0;
  const apt: HostAptGet = {
    available: async () => options.available ?? true,
    run: async (args) => {
      calls.push(args);
      if (!args.includes("install")) return { code: 0, output: "Reading package lists...\n" };
      if (failing > 0) {
        failing -= 1;
        return { code: 100, output: "Reading package lists...\nE: Unable to locate package openbox\n" };
      }
      for (const tool of DESKTOP_TOOLS) await writeFile(join(dir, tool.name), "#!/bin/sh\n", { mode: 0o755 });
      return { code: 0, output: "" };
    }
  };
  return { apt, calls };
}

const verbs = (calls: string[][]) => calls.map((args) => (args.includes("install") ? "install" : "update"));

test("install: apt-get installs the missing packages, refreshing the lists once when it fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeApt(dir, { failingInstalls: 1 });
  const probe = new DesktopHostProbe({ path: () => dir, apt: fake.apt });
  assert.equal((await probe.status()).canInstall, true);

  const status = await probe.install();
  assert.deepEqual(verbs(fake.calls), ["install", "update", "install"]);
  const installed = fake.calls[0]!.slice(fake.calls[0]!.indexOf("--no-install-recommends") + 1);
  assert.deepEqual(installed.slice(0, 2), ["tigervnc-standalone-server", "openbox"]);
  assert.ok(status.tools.every((tool) => tool.path !== null));
});

test("install: a failure after the refresh rejects with apt-get's output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeApt(dir, { failingInstalls: 2 });
  const error = await new DesktopHostProbe({ path: () => dir, apt: fake.apt }).install().then(
    () => assert.fail("install resolved"),
    (e: unknown) => e
  );
  assert.ok(error instanceof DesktopHostInstallError);
  assert.equal(error.reason, "failed");
  assert.match(error.message, /Unable to locate package openbox/);
  assert.deepEqual(verbs(fake.calls), ["install", "update", "install"]);
});

test("install: without apt-get as root nothing runs and the hint comes back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeApt(dir, { available: false });
  const probe = new DesktopHostProbe({ path: () => dir, apt: fake.apt });
  assert.equal((await probe.status()).canInstall, undefined);
  await assert.rejects(probe.install(), (error: unknown) => {
    assert.ok(error instanceof DesktopHostInstallError);
    assert.equal(error.reason, "unavailable");
    assert.match(error.hint ?? "", /^sudo apt-get install -y tigervnc-standalone-server /);
    return true;
  });
  assert.deepEqual(fake.calls, []);
});
