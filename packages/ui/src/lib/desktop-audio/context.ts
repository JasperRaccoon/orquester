// The one app-wide AudioContext every desktop tab plays through (spec §8.2, §10.5). It is created
// or resumed only by `unlockDesktopAudio()` inside a user gesture, so a single "Enable sound" per
// page load unlocks every desktop tab. `isDesktopAudioUnlocked()` is true while the context runs;
// if the OS interrupts or suspends it, it is resumed when possible and the flag follows its state.
import playerWorkletUrl from "./player.worklet.ts?worker&url";

let context: AudioContext | null = null;
let workletModule: Promise<void> | null = null;
let workletLoaded = false;
let unlocked = false;
const listeners = new Set<() => void>();

/** Web Audio with AudioWorklet (absent e.g. under Lockdown Mode). */
export function desktopAudioSupported(): boolean {
  return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

export function isDesktopAudioUnlocked(): boolean {
  return unlocked;
}

export function subscribeDesktopAudioUnlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The shared context, once a gesture has created it. */
export function desktopAudioContext(): AudioContext | null {
  return context;
}

/**
 * Create or resume the shared context. Call synchronously from a click/touchend handler: the
 * context is created and `resume()` called before the first `await`.
 */
export async function unlockDesktopAudio(): Promise<void> {
  if (!desktopAudioSupported()) throw new Error("This browser has no Web Audio support.");
  const ctx = context ?? createContext();
  const resumed = ctx.resume();
  primeWithSilence(ctx);
  await resumed;
  await loadDesktopAudioWorklet(ctx);
  syncUnlocked();
}

/** The player worklet module, added once per context. */
export function loadDesktopAudioWorklet(ctx: AudioContext): Promise<void> {
  if (!workletModule) {
    workletModule = ctx.audioWorklet.addModule(playerWorkletUrl).then(
      () => {
        workletLoaded = true;
      },
      (error: unknown) => {
        workletModule = null;
        throw error;
      }
    );
  }
  return workletModule;
}

function createContext(): AudioContext {
  // Safari 16.4+: a "playback" session isn't muted by the iOS silent switch.
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = "playback";
    } catch {
      // Read-only or unsupported value: keep the default session.
    }
  }
  const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  context = ctx;
  ctx.addEventListener("statechange", () => {
    // Safari's non-standard "interrupted" (calls, Siri, other audio apps): ask to come back.
    if ((ctx.state as string) === "interrupted") void ctx.resume().catch(() => {});
    syncUnlocked();
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ctx.state !== "running" && (ctx.state as string) !== "closed") {
        void ctx.resume().then(syncUnlocked, () => {});
      }
    });
  }
  return ctx;
}

/** Older iOS only fully unlocks output once something has played inside the gesture. */
function primeWithSilence(ctx: AudioContext): void {
  try {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start();
  } catch {
    // Priming is best effort.
  }
}

function syncUnlocked(): void {
  const next = context?.state === "running" && workletLoaded;
  if (next === unlocked) return;
  unlocked = next;
  for (const listener of listeners) listener();
}
