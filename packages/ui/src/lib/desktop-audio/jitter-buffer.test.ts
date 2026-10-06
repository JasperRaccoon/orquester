import test from "node:test";
import assert from "node:assert/strict";

import { JitterBuffer } from "./jitter-buffer.ts";

const RATE = 48_000;
const QUANTUM = 128;
const PACKET = 480; // 10 ms
const MARGIN_FRAMES = (40 * RATE) / 1000;

/** Deterministic PRNG (mulberry32) so the jittered runs are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stream {
  /** Receiver-clock arrival time of packet `k`, in seconds. */
  arrival(k: number): number;
  packet(k: number): Float32Array[];
}

interface RunResult {
  buffer: JitterBuffer;
  output: Float32Array[];
  maxExcessFrames: number;
  maxTargetMs: number;
  depthsMs: number[];
}

/**
 * Drives a buffer on the receiver clock: before each render quantum, every packet that has
 * arrived by then is pushed. `record` keeps the rendered audio (short runs only).
 */
function run(buffer: JitterBuffer, stream: Stream, seconds: number, record = false): RunResult {
  const quanta = Math.floor((seconds * RATE) / QUANTUM);
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const output = record ? [new Float32Array(quanta * QUANTUM), new Float32Array(quanta * QUANTUM)] : [];
  let next = 0;
  let maxExcessFrames = -Infinity;
  let maxTargetMs = 0;
  const depthsMs: number[] = [];
  for (let q = 0; q < quanta; q++) {
    const now = (q * QUANTUM) / RATE;
    while (stream.arrival(next) <= now) buffer.push(stream.packet(next++));
    buffer.render(out);
    const stats = buffer.stats();
    maxExcessFrames = Math.max(maxExcessFrames, ((stats.depthMs - stats.targetMs) * RATE) / 1000);
    maxTargetMs = Math.max(maxTargetMs, stats.targetMs);
    if (q % 375 === 0) depthsMs.push(stats.depthMs); // every second
    if (record) {
      output[0]!.set(out[0]!, q * QUANTUM);
      output[1]!.set(out[1]!, q * QUANTUM);
    }
  }
  return { buffer, output, maxExcessFrames, maxTargetMs, depthsMs };
}

/** Sender clock off by `ppm`, with in-order (TCP) arrival jitter of up to `jitterMs`. */
function driftingStream(ppm: number, jitterMs: number, seed: number): Stream {
  const random = prng(seed);
  const silence = [new Float32Array(PACKET), new Float32Array(PACKET)];
  const arrivals: number[] = [];
  return {
    arrival(k) {
      while (arrivals.length <= k) {
        const i = arrivals.length;
        const sent = (i * 0.01) / (1 + ppm * 1e-6);
        const jittered = sent + (random() * jitterMs) / 1000;
        arrivals.push(Math.max(jittered, arrivals[i - 1] ?? 0));
      }
      return arrivals[k]!;
    },
    packet: () => silence
  };
}

/** A continuous 440 Hz sine across packets, so any step in the output is the buffer's doing. */
function sinePacket(k: number): Float32Array[] {
  const plane = new Float32Array(PACKET);
  for (let i = 0; i < PACKET; i++) plane[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (k * PACKET + i)) / RATE);
  return [plane, plane.slice()];
}

function maxStep(signal: Float32Array): number {
  let max = 0;
  for (let i = 1; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]! - signal[i - 1]!));
  return max;
}

// The sine's own largest sample-to-sample step is 0.5·2π·440/48000 ≈ 0.029. A hard cut,
// a hard start or a jump of a few packets would step by up to 1.0.
const SMOOTH_STEP = 0.05;

for (const ppm of [100, -100]) {
  test(`${ppm > 0 ? "+" : ""}${ppm} ppm drift over 2 simulated hours keeps depth ≤ target + 40 ms`, () => {
    const result = run(new JitterBuffer(), driftingStream(ppm, 5, 7), 2 * 60 * 60);
    assert.ok(result.maxExcessFrames <= MARGIN_FRAMES, `depth exceeded target by ${result.maxExcessFrames} frames`);
    const stats = result.buffer.stats();
    if (ppm > 0) {
      // 100 ppm over 2 h is 720 ms of surplus: the overflow rule must have dropped it.
      assert.ok(stats.drops >= 60, `drops ${stats.drops}`);
      assert.equal(stats.underruns, 0);
    } else {
      // A slow sender runs dry every few minutes; the target recovers between times.
      assert.ok(stats.underruns > 0 && stats.underruns < 60, `underruns ${stats.underruns}`);
      assert.ok(result.maxTargetMs <= 40, `target climbed to ${result.maxTargetMs} ms`);
    }
  });
}

test("a burst after a 300 ms stall recovers without growing latency", () => {
  const stallStart = 5; // seconds
  const stallEnd = stallStart + 0.3;
  const stream: Stream = {
    // Packets sent during the stall arrive together when it ends (TCP holds them back).
    arrival: (k) => {
      const sent = k * 0.01;
      return sent >= stallStart && sent < stallEnd ? stallEnd : sent;
    },
    packet: sinePacket
  };
  const result = run(new JitterBuffer(), stream, 10, true);
  const stats = result.buffer.stats();
  assert.equal(stats.underruns, 1);
  assert.equal(stats.targetMs, 40);
  assert.ok(stats.drops >= 25, `the backlog was dropped, not played late (drops ${stats.drops})`);
  assert.ok(result.maxExcessFrames <= MARGIN_FRAMES);
  const before = result.depthsMs[4]!; // t = 4 s
  const after = result.depthsMs[9]!; // t = 9 s
  assert.ok(after <= before + 10 + 10, `depth ${before} ms before the stall, ${after} ms after`);
  assert.ok(maxStep(result.output[0]!) <= SMOOTH_STEP, `step ${maxStep(result.output[0]!)}`);
});

test("underruns raise the target by 10 ms up to 150 ms", () => {
  const buffer = new JitterBuffer();
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const expected = [40, 50, 60];
  for (const target of expected) {
    // Fill to the current target, play it out, then starve it.
    while (buffer.stats().depthMs < buffer.stats().targetMs) {
      buffer.push(sinePacket(0));
    }
    const prior = buffer.stats().underruns;
    do { buffer.render(out); } while (buffer.stats().underruns === prior);
    assert.equal(buffer.stats().targetMs, target);
  }
  for (let i = 0; i < 20; i++) {
    while (buffer.stats().depthMs < buffer.stats().targetMs) {
      buffer.push(sinePacket(0));
    }
    const prior = buffer.stats().underruns;
    do { buffer.render(out); } while (buffer.stats().underruns === prior);
  }
  assert.equal(buffer.stats().targetMs, 150);
  assert.equal(buffer.stats().underruns, 23);
});

test("stable periods lower the target by 5 ms per 30 s down to 20 ms", () => {
  const buffer = new JitterBuffer({ initialTargetMs: 60 });
  const steady: Stream = { arrival: (k) => k * 0.01, packet: sinePacket };
  const q30s = (30 * RATE) / QUANTUM;
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  let next = 0;
  const playFor = (quanta: number, from: number) => {
    for (let q = from; q < from + quanta; q++) {
      while (steady.arrival(next) <= (q * QUANTUM) / RATE) buffer.push(steady.packet(next++));
      buffer.render(out);
    }
    return from + quanta;
  };
  let q = playFor(Math.ceil(q30s) + 50, 0); // + the 60 ms it buffers first
  assert.equal(buffer.stats().targetMs, 55);
  q = playFor(Math.ceil(q30s * 12), q);
  assert.equal(buffer.stats().targetMs, 20);
  assert.equal(buffer.stats().underruns, 0);
});

test("an overflow drop crossfades instead of stepping", () => {
  const buffer = new JitterBuffer();
  // Steady, then 8 extra packets at once (80 ms early): depth passes target + 40 ms.
  const stream: Stream = { arrival: (k) => (k < 200 ? k * 0.01 : Math.max(2, (k - 8) * 0.01)), packet: sinePacket };
  const result = run(buffer, stream, 4, true);
  const stats = buffer.stats();
  assert.ok(stats.drops > 0, "the burst triggered a drop");
  assert.equal(stats.underruns, 0);
  assert.ok(result.maxExcessFrames <= MARGIN_FRAMES);
  assert.ok(maxStep(result.output[0]!) <= SMOOTH_STEP, `step ${maxStep(result.output[0]!)}`);
  assert.ok(maxStep(result.output[1]!) <= SMOOTH_STEP);
});

test("an underrun ramps to silence and the restart fades in", () => {
  const buffer = new JitterBuffer();
  // A 100 ms hole in the stream (the seq gap case: nothing is inserted), away from a zero crossing.
  const stream: Stream = { arrival: (k) => (k < 103 ? k * 0.01 : k * 0.01 + 0.1), packet: sinePacket };
  const result = run(buffer, stream, 3, true);
  assert.equal(buffer.stats().underruns, 1);
  assert.ok(maxStep(result.output[0]!) <= SMOOTH_STEP, `step ${maxStep(result.output[0]!)}`);
  // It really went silent in between.
  const silentAt = Math.round(1.1 * RATE);
  assert.equal(result.output[0]![silentAt], 0);
});

test("underrun partway through a fade-in blends from the ramp instead of jumping", () => {
  const buffer = new JitterBuffer();
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const signal: number[] = [];
  const loud = [new Float32Array(PACKET).fill(0.9), new Float32Array(PACKET).fill(0.9)];
  const quiet = [new Float32Array(PACKET).fill(-0.9), new Float32Array(PACKET).fill(-0.9)];
  // Play loud, starve, refill with the opposite level straight away.
  for (let i = 0; i < 4; i++) buffer.push(loud);
  let underruns = 0;
  for (let i = 0; i < 20; i++) {
    buffer.render(out);
    signal.push(...out[0]!);
    if (buffer.stats().underruns > underruns) {
      underruns = buffer.stats().underruns;
      for (let p = 0; p < 6; p++) buffer.push(quiet);
    }
  }
  // The fades are linear over 120 frames: a full-scale swing moves ≤ 2·0.9/120 per frame.
  assert.ok(maxStep(Float32Array.from(signal)) <= 0.02, `step ${maxStep(Float32Array.from(signal))}`);
});

test("a mono packet plays on both channels", () => {
  const buffer = new JitterBuffer({ initialTargetMs: 20 });
  const mono = new Float32Array(PACKET).fill(0.25);
  for (let i = 0; i < 3; i++) buffer.push([mono]);
  const out = [new Float32Array(QUANTUM * 4), new Float32Array(QUANTUM * 4)];
  buffer.render(out);
  assert.equal(out[0]![QUANTUM * 3], 0.25);
  assert.equal(out[1]![QUANTUM * 3], 0.25);
});
