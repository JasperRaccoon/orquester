// Adaptive jitter buffer for the desktop audio stream (spec §8.2). A pure policy: no DOM, no
// timers. Its clock is the output itself — every `render` call advances time by the frames it
// renders — so the AudioWorklet processor is a thin shell around it and tests drive it with a
// simulated clock by interleaving `push` (sender clock) and `render` (receiver clock).
//
// | Rule      | Behaviour                                                                        |
// |-----------|----------------------------------------------------------------------------------|
// | Start     | buffer `initialTargetMs` before playing                                          |
// | Underrun  | silence, target += `underrunStepMs` (≤ max), re-buffer to target, fade in         |
// | Stable    | `stableAfterMs` of playback without an underrun → target −= `stableStepMs` (≥ min) |
// | Overflow  | depth > target + `overflowMarginMs` → drop the oldest whole packets, crossfade     |
//
// Every transition is ramped over `fadeMs`: silence starts with a ramp from the last output
// sample to zero, playback starts with a fade-in from wherever that ramp is, and a drop crossfades
// from the old read position to the new one. No transition produces a step.

export interface DesktopAudioStats {
  depthMs: number;
  targetMs: number;
  underruns: number;
  drops: number;
}

interface JitterBufferOptions {
  sampleRate: number;
  channels: number;
  initialTargetMs: number;
  minTargetMs: number;
  maxTargetMs: number;
  underrunStepMs: number;
  stableStepMs: number;
  stableAfterMs: number;
  overflowMarginMs: number;
  fadeMs: number;
  /** Hard ring capacity; anything beyond is dropped oldest-first on push. */
  capacityMs: number;
}

const JITTER_BUFFER_DEFAULTS: JitterBufferOptions = {
  sampleRate: 48_000,
  channels: 2,
  initialTargetMs: 30,
  minTargetMs: 20,
  maxTargetMs: 150,
  underrunStepMs: 10,
  stableStepMs: 5,
  stableAfterMs: 30_000,
  overflowMarginMs: 40,
  fadeMs: 2.5,
  capacityMs: 2_000
};

export class JitterBuffer {
  private readonly opts: JitterBufferOptions;
  private readonly rings: Float32Array[];
  private readonly capacity: number;
  private readonly fadeLen: number;
  private readonly marginFrames: number;
  private readIdx = 0;
  private size = 0;
  private playing = false;
  private targetFrames: number;
  /** Output frames rendered so far: the policy's clock. */
  private clock = 0;
  private stableSince = 0;
  /** Frames per packet, from the latest push; drops are whole multiples of it. */
  private packetFrames = 480;
  /** Fade-in progress; `>= fadeLen` means none in progress. */
  private fadeInPos: number;
  /** Ramp-to-silence progress from `rampFrom`; `>= fadeLen` means fully silent. */
  private rampPos: number;
  private readonly rampFrom: Float32Array;
  private readonly last: Float32Array;
  /** Drop in progress: crossfading from `readIdx` to `readIdx + offset`. */
  private dropOffset = 0;
  private dropPos = 0;
  private underrunCount = 0;
  private dropCount = 0;

  constructor(options: Partial<Pick<JitterBufferOptions, "sampleRate" | "channels" | "initialTargetMs">> = {}) {
    this.opts = { ...JITTER_BUFFER_DEFAULTS, ...options };
    const { sampleRate, channels } = this.opts;
    this.capacity = Math.ceil((this.opts.capacityMs * sampleRate) / 1000);
    this.rings = Array.from({ length: channels }, () => new Float32Array(this.capacity));
    this.fadeLen = Math.max(1, Math.round((this.opts.fadeMs * sampleRate) / 1000));
    this.marginFrames = this.msToFrames(this.opts.overflowMarginMs);
    this.targetFrames = this.msToFrames(clamp(this.opts.initialTargetMs, this.opts.minTargetMs, this.opts.maxTargetMs));
    this.fadeInPos = this.fadeLen;
    this.rampPos = this.fadeLen;
    this.rampFrom = new Float32Array(channels);
    this.last = new Float32Array(channels);
  }

  /** Buffered audio not already committed to a drop, in frames. */
  private get depthFrames(): number {
    return this.size - this.dropOffset;
  }

  private get targetMs(): number {
    return this.framesToMs(this.targetFrames);
  }

  stats(): DesktopAudioStats {
    return {
      depthMs: this.framesToMs(this.depthFrames),
      targetMs: this.targetMs,
      underruns: this.underrunCount,
      drops: this.dropCount
    };
  }

  /** Append one decoded packet (planar; a mono packet is duplicated to every channel). */
  push(planes: readonly Float32Array[]): void {
    const frames = planes[0]?.length ?? 0;
    if (frames === 0) return;
    this.packetFrames = frames;
    if (frames > this.capacity) {
      // Absurdly large packet: keep only its newest part.
      const start = frames - this.capacity;
      this.push(planes.map((plane) => plane.subarray(start)));
      return;
    }
    const overflow = this.size + frames - this.capacity;
    if (overflow > 0) {
      this.cancelDrop();
      this.discard(overflow);
      this.dropCount += Math.max(1, Math.round(overflow / frames));
    }
    const writeIdx = (this.readIdx + this.size) % this.capacity;
    const first = Math.min(frames, this.capacity - writeIdx);
    for (let ch = 0; ch < this.rings.length; ch++) {
      const src = planes[Math.min(ch, planes.length - 1)]!;
      const ring = this.rings[ch]!;
      ring.set(src.subarray(0, first), writeIdx);
      if (first < frames) ring.set(src.subarray(first), 0);
    }
    this.size += frames;
  }

  /** Render `frames` output frames (defaults to the output length) and advance the clock. */
  render(outputs: readonly Float32Array[], frames = outputs[0]?.length ?? 0): void {
    let i = 0;
    while (i < frames) {
      if (!this.playing) {
        if (this.size >= this.targetFrames) this.start();
        else {
          this.writeSilence(outputs, i, frames);
          break;
        }
      }
      if (this.dropOffset === 0 && this.size > this.targetFrames + this.marginFrames) this.beginDrop();
      if (this.size < this.dropOffset + 1) {
        this.underrun();
        continue;
      }
      if (this.dropOffset === 0 && this.fadeInPos >= this.fadeLen) {
        i += this.copyRun(outputs, i, frames - i);
      } else {
        this.renderTransitionFrame(outputs, i);
        i++;
      }
    }
    this.clock += frames;
    if (this.playing && this.clock - this.stableSince >= this.msToFrames(this.opts.stableAfterMs)) {
      this.setTarget(this.targetFrames - this.msToFrames(this.opts.stableStepMs));
      this.stableSince = this.clock;
    }
  }

  private start(): void {
    // Arriving after a stall with a backlog: skip straight to the target rather than play the
    // backlog late. Fading in from silence, so no crossfade is needed.
    const excess = this.size - this.targetFrames;
    if (excess > this.marginFrames) {
      const drop = this.wholePackets(excess);
      this.discard(drop);
      this.dropCount += Math.round(drop / this.packetFrames);
    }
    this.playing = true;
    this.fadeInPos = 0;
    this.stableSince = this.clock;
  }

  private underrun(): void {
    this.underrunCount++;
    this.setTarget(this.targetFrames + this.msToFrames(this.opts.underrunStepMs));
    this.stopPlaying();
  }

  private stopPlaying(): void {
    this.playing = false;
    this.cancelDrop();
    this.rampFrom.set(this.last);
    this.rampPos = 0;
    this.fadeInPos = this.fadeLen;
  }

  private beginDrop(): void {
    const drop = this.wholePackets(this.size - this.targetFrames);
    if (drop <= 0 || this.size < drop + this.fadeLen) return;
    this.dropOffset = drop;
    this.dropPos = 0;
    this.dropCount += Math.round(drop / this.packetFrames);
  }

  private cancelDrop(): void {
    this.dropOffset = 0;
    this.dropPos = 0;
  }

  /** Largest multiple of the packet size ≤ `frames` (or `frames` itself if under one packet). */
  private wholePackets(frames: number): number {
    const packets = Math.floor(frames / this.packetFrames);
    return packets > 0 ? packets * this.packetFrames : frames;
  }

  /** Plain playback: contiguous copies straight out of the ring. */
  private copyRun(outputs: readonly Float32Array[], at: number, want: number): number {
    const n = Math.min(want, this.size, this.capacity - this.readIdx);
    for (let ch = 0; ch < this.rings.length; ch++) {
      const out = outputs[ch];
      const ring = this.rings[ch]!;
      if (out) out.set(ring.subarray(this.readIdx, this.readIdx + n), at);
      this.last[ch] = ring[this.readIdx + n - 1]!;
    }
    this.advance(n);
    return n;
  }

  /** One frame of fade-in and/or drop crossfade. */
  private renderTransitionFrame(outputs: readonly Float32Array[], at: number): void {
    const fading = this.fadeInPos < this.fadeLen;
    const gain = fading ? (this.fadeInPos + 1) / (this.fadeLen + 1) : 1;
    const ramp = fading ? this.rampGain() : 0;
    const w = this.dropOffset > 0 ? (this.dropPos + 1) / (this.fadeLen + 1) : 0;
    const newIdx = (this.readIdx + this.dropOffset) % this.capacity;
    for (let ch = 0; ch < this.rings.length; ch++) {
      const ring = this.rings[ch]!;
      let v = ring[this.readIdx]!;
      if (this.dropOffset > 0) v = v * (1 - w) + ring[newIdx]! * w;
      if (fading) v = v * gain + this.rampFrom[ch]! * ramp * (1 - gain);
      const out = outputs[ch];
      if (out) out[at] = v;
      this.last[ch] = v;
    }
    if (fading) {
      this.fadeInPos++;
      this.rampPos++;
    }
    this.advance(1);
    if (this.dropOffset > 0 && ++this.dropPos >= this.fadeLen) {
      this.discard(this.dropOffset);
      this.cancelDrop();
    }
  }

  /** Silence, starting with the rest of the ramp from the last output sample down to zero. */
  private writeSilence(outputs: readonly Float32Array[], from: number, to: number): void {
    let i = from;
    for (; i < to && this.rampPos < this.fadeLen; i++, this.rampPos++) {
      const ramp = this.rampGain();
      for (let ch = 0; ch < this.rings.length; ch++) {
        const v = this.rampFrom[ch]! * ramp;
        const out = outputs[ch];
        if (out) out[i] = v;
        this.last[ch] = v;
      }
    }
    if (i < to) for (const out of outputs) out.fill(0, i, to);
  }

  /** Remaining gain of the ramp from `rampFrom` to silence. */
  private rampGain(): number {
    return this.rampPos >= this.fadeLen ? 0 : 1 - (this.rampPos + 1) / this.fadeLen;
  }

  private advance(frames: number): void {
    this.readIdx = (this.readIdx + frames) % this.capacity;
    this.size -= frames;
  }

  private discard(frames: number): void {
    const n = Math.min(frames, this.size);
    this.advance(n);
  }

  private setTarget(frames: number): void {
    const min = this.msToFrames(this.opts.minTargetMs);
    const max = this.msToFrames(this.opts.maxTargetMs);
    this.targetFrames = clamp(frames, min, max);
  }

  private msToFrames(ms: number): number {
    return Math.round((ms * this.opts.sampleRate) / 1000);
  }

  private framesToMs(frames: number): number {
    return (frames * 1000) / this.opts.sampleRate;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
