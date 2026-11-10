/**
 * Latching modifier keys for touch key bars (the terminal's `MobileKeyBar` and
 * the desktop key bar): a phone keyboard has no Ctrl, Alt, Shift or Super to
 * hold, so a key-bar modifier latches instead.
 *
 * A tap arms it for the next key (or click) only; a second tap within
 * `LATCH_DOUBLE_TAP_MS` locks it until it is tapped again. Pure: the callers
 * keep the latches in their own store or state.
 */

export type LatchState = "off" | "armed" | "locked";

/** One modifier's latch; `armedAt` dates the first tap so a second can lock it. */
export interface ModifierLatch {
  state: LatchState;
  armedAt: number | null;
}

/** The window in which a second tap locks an armed modifier instead of releasing it. */
export const LATCH_DOUBLE_TAP_MS = 350;

export const LATCH_OFF: ModifierLatch = { state: "off", armedAt: null };

/** off → armed; armed → locked on a quick second tap, else off; locked → off. */
export function tapLatch(latch: ModifierLatch, now: number): ModifierLatch {
  if (latch.state === "off") return { state: "armed", armedAt: now };
  if (latch.state === "armed" && latch.armedAt !== null && now - latch.armedAt <= LATCH_DOUBLE_TAP_MS) {
    return { state: "locked", armedAt: null };
  }
  return LATCH_OFF;
}

/** After a key went out: a one-shot (armed) modifier is spent, a locked one stays. */
export function consumeLatch(latch: ModifierLatch): ModifierLatch {
  return latch.state === "armed" ? LATCH_OFF : latch;
}

/** Several named latches, e.g. a key bar's Shift/Ctrl/Alt/Super. */
export type LatchSet<M extends string> = Readonly<Record<M, ModifierLatch>>;

/** Every latch in `names` off. */
export function latchSet<M extends string>(names: readonly M[]): LatchSet<M> {
  const out = {} as Record<M, ModifierLatch>;
  for (const name of names) out[name] = LATCH_OFF;
  return out;
}

export function tapLatchIn<M extends string>(set: LatchSet<M>, name: NoInfer<M>, now: number): LatchSet<M> {
  return { ...set, [name]: tapLatch(set[name], now) };
}

/** The modifiers that apply to the next key: every latch that is not off, in `set`'s key order. */
export function latchedNames<M extends string>(set: LatchSet<M>): M[] {
  return (Object.keys(set) as M[]).filter((name) => set[name].state !== "off");
}

/** A key went out: spend the one-shots. Returns `set` itself when nothing changed. */
export function consumeLatchSet<M extends string>(set: LatchSet<M>): LatchSet<M> {
  let next: Record<M, ModifierLatch> | null = null;
  for (const name of Object.keys(set) as M[]) {
    const latch = consumeLatch(set[name]);
    if (latch === set[name]) continue;
    next ??= { ...set };
    next[name] = latch;
  }
  return next ?? set;
}
