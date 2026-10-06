import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { DesktopAudioStateMessage } from "@orquester/api";
import {
  DesktopAudioHub,
  type DesktopAudioEncoderExit,
  type DesktopAudioHubOptions,
  type DesktopAudioSink
} from "./audio.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/tone-440hz-200ms.opus.ogg", import.meta.url));

/** A sink that records everything and lets a test await a condition on what it saw. */
class FakeSink implements DesktopAudioSink {
  states: DesktopAudioStateMessage[] = [];
  packets: Buffer[] = [];
  closed = false;
  buffered = 0;
  private waiters: Array<{ check: () => boolean; resolve: () => void }> = [];

  send(packet: Buffer): void {
    this.packets.push(packet);
    this.poke();
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  sendState(state: DesktopAudioStateMessage): void {
    this.states.push(state);
    this.poke();
  }
  close(): void {
    this.closed = true;
    this.poke();
  }
  until(check: () => boolean): Promise<void> {
    if (check()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ check, resolve }));
  }
  private poke(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.check()) return true;
      waiter.resolve();
      return false;
    });
  }
}

/** Collects `onEncoderExit` calls and lets a test await the next one. */
function exitRecorder() {
  const exits: Array<DesktopAudioEncoderExit & { desktopId: string; at: number }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    exits,
    onEncoderExit: (desktopId: string, exit: DesktopAudioEncoderExit) => {
      exits.push({ ...exit, desktopId, at: Date.now() });
      for (const waiter of waiters.filter((w) => exits.length >= w.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    /** Resolve once `count` exits in total have been recorded. */
    until: (count: number) =>
      exits.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve }))
  };
}

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeFfmpeg(dir: string, body: string): string {
  const path = join(dir, "ffmpeg");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function hub(t: TestContext, options: DesktopAudioHubOptions): DesktopAudioHub {
  const instance = new DesktopAudioHub(options);
  t.after(() => instance.shutdown());
  return instance;
}

test("no ffmpeg: the sink hears audio unavailable and nothing spawns", (t) => {
  const audio = hub(t, { ffmpegPath: null });
  const sink = new FakeSink();
  const unsubscribe = audio.subscribe("d1", "/run/d1/pulse/native", sink);
  assert.equal(sink.states.length, 1);
  assert.equal(sink.states[0]!.audio, "unavailable");
  assert.match(sink.states[0]!.reason ?? "", /ffmpeg/);
  assert.equal(audio.encoderPid("d1"), null);
  unsubscribe();
});

test("one encoder per desktop: framed packets with seq fan out; a backed-up sink is skipped", async (t) => {
  const dir = tempDir(t, "orq-audio-");
  const recorder = exitRecorder();
  const audio = hub(t, {
    ffmpegPath: fakeFfmpeg(dir, `cat '${FIXTURE_PATH}'\nexec sleep 600`),
    stopGraceMs: 100,
    onEncoderExit: recorder.onEncoderExit
  });

  const fast = new FakeSink();
  const slow = new FakeSink();
  slow.buffered = 64 * 1024;
  const offFast = audio.subscribe("d1", "/run/d1/pulse/native", fast);
  const offSlow = audio.subscribe("d1", "/run/d1/pulse/native", slow);
  const pid = audio.encoderPid("d1");
  assert.ok(pid);

  await fast.until(() => fast.packets.length === 21);
  const available = { type: "state", audio: "available", sampleRate: 48000, channels: 2, frameMs: 10 };
  assert.deepEqual(fast.states, [available]);
  assert.deepEqual(slow.states, [available]);
  fast.packets.forEach((packet, seq) => {
    assert.equal(packet[0], 1);
    assert.equal(packet[1], 0);
    assert.equal(packet.readUInt16BE(2), 0);
    assert.equal(packet.readUInt32BE(4), seq);
  });
  // Digest of the 21 audio page bodies in the captured ffmpeg fixture, excluding
  // OpusHead and OpusTags. Keep this oracle independent of the production splitter.
  assert.equal(
    createHash("sha256").update(Buffer.concat(fast.packets.map((packet) => packet.subarray(8)))).digest("hex"),
    "a474ea88feced6449ce851f9c0ba7852a64eba21a3ab732b016a8ec4ce049707"
  );
  assert.equal(slow.packets.length, 0);

  // Leaving and rejoining within the grace keeps the same encoder.
  offFast();
  offSlow();
  const again = new FakeSink();
  const offAgain = audio.subscribe("d1", "/run/d1/pulse/native", again);
  assert.equal(audio.encoderPid("d1"), pid);
  assert.equal(recorder.exits.length, 0);

  // The last subscriber leaving stops the encoder after the grace, with SIGKILL.
  const left = Date.now();
  offAgain();
  offAgain(); // idempotent
  await recorder.until(1);
  assert.deepEqual(recorder.exits.map(({ desktopId, expected: e, signal }) => ({ desktopId, e, signal })), [
    { desktopId: "d1", e: true, signal: "SIGKILL" }
  ]);
  assert.ok(recorder.exits[0]!.at - left >= 90, "stopped only after the grace");
  assert.equal(audio.encoderPid("d1"), null);
});

test("an encoder that keeps failing restarts with backoff, then reports unavailable with the reason", async (t) => {
  const dir = tempDir(t, "orq-audio-");
  const recorder = exitRecorder();
  const audio = hub(t, {
    ffmpegPath: fakeFfmpeg(dir, `echo "Connection refused: pulse is gone" >&2\nexit 1`),
    restartBackoffMs: [5, 10],
    onEncoderExit: recorder.onEncoderExit
  });
  const sink = new FakeSink();
  audio.subscribe("d1", "/run/d1/pulse/native", sink);
  await sink.until(() => sink.states.length === 2);
  assert.equal(sink.states[0]!.audio, "available");
  assert.equal(sink.states[1]!.audio, "unavailable");
  assert.match(sink.states[1]!.reason ?? "", /code 1.*Connection refused: pulse is gone/);
  assert.ok(recorder.exits.length >= 3);
  assert.ok(recorder.exits.every((exit) => !exit.expected && exit.code === 1));

  // A new subscriber hears the current state.
  const late = new FakeSink();
  audio.subscribe("d1", "/run/d1/pulse/native", late);
  assert.equal(late.states[0]!.audio, "unavailable");

  // stopDesktop ends the streams and the retries.
  audio.stopDesktop("d1");
  assert.equal(sink.closed, true);
  assert.equal(late.closed, true);
  assert.equal(audio.encoderPid("d1"), null);
});

test("stopDesktop and shutdown kill encoders now; shutdown refuses new subscribers", async (t) => {
  const dir = tempDir(t, "orq-audio-");
  const recorder = exitRecorder();
  const audio = hub(t, {
    ffmpegPath: fakeFfmpeg(dir, "exec sleep 600"),
    onEncoderExit: recorder.onEncoderExit
  });
  const one = new FakeSink();
  audio.subscribe("d1", "/a/native", one);
  audio.subscribe("d2", "/b/native", new FakeSink());
  audio.subscribe("d3", "/c/native", new FakeSink());
  audio.stopDesktop("d1");
  assert.equal(one.closed, true);
  await recorder.until(1);
  assert.equal(recorder.exits[0]!.desktopId, "d1");
  audio.shutdown();
  await recorder.until(3);
  assert.deepEqual(recorder.exits.map((exit) => [exit.desktopId, exit.expected, exit.signal]).sort(), [
    ["d1", true, "SIGKILL"],
    ["d2", true, "SIGKILL"],
    ["d3", true, "SIGKILL"]
  ]);
  const after = new FakeSink();
  audio.subscribe("d2", "/b/native", after);
  assert.equal(after.states[0]!.audio, "unavailable");
  assert.equal(audio.encoderPid("d2"), null);
});

// ---------------------------------------------------------------------------
// Integration: a throwaway PulseAudio with the desktop's null sink, real ffmpeg.
// ---------------------------------------------------------------------------

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function ffmpegHasPulseAndOpus(ffmpeg: string): boolean {
  const devices = spawnSync(ffmpeg, ["-hide_banner", "-devices"], { encoding: "utf8" }).stdout ?? "";
  const encoders = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  return /\bpulse\b/.test(devices) && /\blibopus\b/.test(encoders);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Start PulseAudio in `dir` and resolve with its socket once it exists (fs.watch, no polling). */
async function startPulse(t: TestContext, dir: string): Promise<string> {
  const runtime = join(dir, "pulse");
  mkdirSync(runtime, { mode: 0o700 });
  const socketPath = join(runtime, "native");
  writeFileSync(
    join(dir, "default.pa"),
    [
      `load-module module-native-protocol-unix socket=${socketPath} auth-anonymous=1`,
      "load-module module-null-sink sink_name=orq",
      "set-default-sink orq",
      ""
    ].join("\n")
  );
  const pulse = spawn(
    "pulseaudio",
    ["-n", "-F", join(dir, "default.pa"), "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--system=no"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        PULSE_RUNTIME_PATH: runtime,
        PULSE_STATE_PATH: join(dir, "state"),
        XDG_RUNTIME_DIR: dir
      }
    }
  );
  let stderr = "";
  pulse.stderr!.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  t.after(async () => {
    pulse.kill("SIGTERM");
    await exited(pulse);
  });

  await new Promise<void>((resolve, reject) => {
    const watcher = watch(runtime, () => {
      if (existsSync(socketPath)) finish();
    });
    const timer = setTimeout(() => finish(new Error(`pulseaudio socket did not appear: ${stderr}`)), 10_000);
    const onExit = (code: number | null) => finish(new Error(`pulseaudio exited (${code}): ${stderr}`));
    pulse.once("exit", onExit);
    function finish(error?: Error) {
      watcher.close();
      clearTimeout(timer);
      pulse.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    if (existsSync(socketPath)) finish();
  });
  return socketPath;
}

function tone(seconds: number): Buffer {
  const frames = Math.round(48000 * seconds);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5 * 32767);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

test("integration: a tone in the desktop's sink arrives as Opus packets; the encoder stops after the grace", { timeout: 60_000 }, async (t) => {
  const ffmpeg = onPath("ffmpeg");
  if (!ffmpeg || !onPath("pulseaudio") || !onPath("pacat") || !ffmpegHasPulseAndOpus(ffmpeg)) {
    t.skip("needs pulseaudio, pacat and ffmpeg with pulse + libopus");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "orq-pa-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = await startPulse(t, dir);

  const recorder = exitRecorder();
  const logs: string[] = [];
  const audio = hub(t, {
    ffmpegPath: ffmpeg,
    stopGraceMs: 200,
    onEncoderExit: recorder.onEncoderExit,
    log: (message) => logs.push(message)
  });
  const sink = new FakeSink();
  const unsubscribe = audio.subscribe("d1", socketPath, sink);
  assert.equal(sink.states[0]!.audio, "available");
  assert.ok(audio.encoderPid("d1"));

  const players: ChildProcess[] = [];
  t.after(async () => {
    for (const player of players) player.kill("SIGKILL");
    await Promise.all(players.map(exited));
  });
  /** Play `pcm` into the desktop's default sink (orq) with a fresh pacat. */
  const play = (pcm: Buffer): ChildProcess => {
    const pacat = spawn(
      "pacat",
      [`--server=unix:${socketPath}`, "--playback", "--format=s16le", "--rate=48000", "--channels=2", "--raw", "--latency-msec=10"],
      { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } }
    );
    players.push(pacat);
    pacat.stdin!.on("error", () => {}); // killed with tone still queued in the pipe
    pacat.stdin!.end(pcm);
    return pacat;
  };

  const payload = (packet: Buffer) => packet.length - 8;
  const loud = () => sink.packets.filter((packet) => payload(packet) > 40);
  // pacat drains its stream and exits at EOF, so the sink is idle again afterwards.
  await exited(play(tone(0.6)));
  await sink.until(() => loud().length >= 30);

  // Latency on a warm encoder: a fresh player's spawn to its first loud packet.
  // An upper bound on sink write → packet: it includes pacat's start and connect.
  const mark = sink.packets.length;
  const spawnedAt = performance.now();
  let loudAt = 0;
  play(tone(0.3));
  await sink.until(() => {
    if (!loudAt && sink.packets.slice(mark).some((packet) => payload(packet) > 40)) loudAt = performance.now();
    return loudAt > 0;
  });
  t.diagnostic(`warm encoder: pacat spawn → first loud packet ${(loudAt - spawnedAt).toFixed(1)} ms`);

  const seqs = sink.packets.map((packet) => packet.readUInt32BE(4));
  seqs.forEach((seq, i) => assert.equal(seq, i, "seq increments per packet"));
  for (const packet of loud()) {
    assert.equal(packet[0], 1);
    assert.equal(packet[8]! >> 3, 30, "CELT fullband 10 ms frames");
  }

  unsubscribe();
  await recorder.until(1);
  assert.equal(recorder.exits[0]!.expected, true);
  assert.equal(audio.encoderPid("d1"), null);
  assert.deepEqual(logs, []);
});
