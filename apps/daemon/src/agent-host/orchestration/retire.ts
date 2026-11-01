/**
 * Agent host — retiring (spec 2026-11-01 P2.3 R18, R19, R21; P2.5 I1, I2, I4).
 *
 * When the host's code changed, the daemon retires this host instead of stopping it: `POST
 * /retire` keeps only the threads with live work, releases every other one, and from then on
 * releases each kept thread at its first idle moment; a new host serves everything else and
 * adopts each released thread. The policy lives here; the orchestrator supplies the mechanics
 * ({@link RetireSeams}) — what live work a thread has, how a continuing goal is held, and the
 * release itself.
 *
 * - **The owned set** (R18) is every loaded thread with live work (an active turn, live
 *   background work, a pending wake, a continuing goal not held yet) and every thread a request
 *   or an effect is in flight for. Every other loaded thread is released before `/retire`
 *   answers; an unloaded thread has nothing in memory, so it is foreign at once.
 * - **Release on idle** (R19): the end of a request, of an effect, and every event of a thread
 *   look at it again ({@link Retirement.poke}); a backstop timer does too, for live work that ends
 *   with no event (a background task's liveness running out). A continuing goal is HELD first —
 *   paused between its turns, marked for the adopting host (goals §5.7) — and its thread then
 *   releases once its turn is over.
 * - **One writer** (I1, I4): a release runs with the thread marked `releasing`, so a request that
 *   arrives meanwhile waits and then answers 409 `THREAD_NOT_OWNED`; the provider session is
 *   closed and the last rows written BEFORE the thread leaves the owned set, which is what the
 *   daemon's adoption waits for (I2).
 */

import type { AdapterLogger } from "../adapter.ts";
import type { ThreadOwnership } from "./ownership.ts";

/** What keeps a thread owned while the host retires; null when it may be released. */
export type RetireLiveWork = "turn" | "background" | "wake" | "goal" | "busy";

/**
 * How often a retiring host looks at its owned threads with no event to prompt it: live work can
 * end silently (a background task's liveness TTL, a goal's continuation grace).
 */
export const RETIRE_RELEASE_BACKSTOP_MS = 15_000;

export interface RetireSeams {
  ownership: ThreadOwnership;
  logger: AdapterLogger;
  /** Threads with a runtime in memory, or one loading. */
  loadedThreadIds(): string[];
  /** The live work of a thread (null: idle, or not loaded). */
  liveWork(threadId: string): RetireLiveWork | null;
  /**
   * A kept thread whose goal continues: hold it (pause it between its turns, marked for the next
   * host). Called for every kept thread; a no-op for one without such a goal. Fire and forget; a
   * hold that does not land is tried again at the thread's next look.
   */
  holdGoal(threadId: string): void;
  /**
   * Release one thread: close its provider session (cursor kept), write its last rows, drop it
   * from memory. Runs between {@link ThreadOwnership.beginRelease} and its finisher; answers
   * false (nothing released) when live work appeared meanwhile.
   */
  release(threadId: string): Promise<boolean>;
  /** Told once a thread left the owned set: its open streams end (clients re-read elsewhere). */
  onReleased?(threadId: string): void;
  /** The host stopped retiring: what a retirement held for the next host is let go of here. */
  onUnretired?(): void;
}

export interface Retirement {
  /** R18. Repeatable: a second call answers the current owned set. */
  retire(): Promise<string[]>;
  /** R21: the released threads are owned again. Answers nothing new to release. */
  unretire(): void;
  /** Look at one thread again (an event, an effect's end). Cheap when not retiring. */
  poke(threadId: string): void;
  /** Every release in flight, settled (§9: tests and the stop wait on this, never a timer). */
  drain(): Promise<void>;
  stop(): void;
}

export function createRetirement(seams: RetireSeams): Retirement {
  const { ownership, logger } = seams;
  const inFlight = new Set<Promise<void>>();
  let backstop: NodeJS.Timeout | null = null;
  let stopped = false;

  const startRelease = (threadId: string): Promise<void> | null => {
    const finish = ownership.beginRelease(threadId);
    if (finish === null) return null;
    const run = (async () => {
      let released = false;
      try {
        released = await seams.release(threadId);
      } catch (error) {
        logger.warn(`agent-host: could not release ${threadId}; it stays on this host`, error);
      } finally {
        finish(released);
      }
      if (released) {
        logger.info("agent-host: released a thread to the next host", { threadId });
        seams.onReleased?.(threadId);
        if (ownership.ownedThreadIds()?.length === 0) clearBackstop();
      }
    })();
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
    return run;
  };

  const poke = (threadId: string): void => {
    if (stopped || !ownership.retiring || ownership.isForeign(threadId) || ownership.releasing(threadId)) return;
    if (ownership.inFlight(threadId) > 0) return;
    const work = seams.liveWork(threadId);
    // A continuing goal is held at once — its turn running or not: the pause stops only its NEXT
    // turn, so the thread is idle at the end of this one.
    if (work !== null && work !== "busy") seams.holdGoal(threadId);
    if (work !== null) return;
    startRelease(threadId);
  };

  const pokeAll = (): void => {
    for (const threadId of ownership.ownedThreadIds() ?? []) poke(threadId);
  };

  const clearBackstop = (): void => {
    if (backstop !== null) clearInterval(backstop);
    backstop = null;
  };

  ownership.onSettled((threadId) => poke(threadId));

  return {
    async retire() {
      if (ownership.retiring) return ownership.ownedThreadIds() ?? [];
      // Everything loaded starts owned — an idle one too, until its release below has closed its
      // session and written its last rows (a thread that is foreign may not be written at all).
      // Every thread a request is in flight for stays owned: its request finishes here.
      ownership.retire([...seams.loadedThreadIds(), ...ownership.inFlightThreadIds()]);
      logger.info("agent-host: retiring; threads with live work stay until they are idle");
      const releases: Array<Promise<void>> = [];
      for (const threadId of ownership.ownedThreadIds() ?? []) {
        if (ownership.inFlight(threadId) > 0) continue;
        const work = seams.liveWork(threadId);
        if (work !== null && work !== "busy") seams.holdGoal(threadId);
        if (work !== null) continue;
        const release = startRelease(threadId);
        if (release !== null) releases.push(release);
      }
      await Promise.all(releases);
      if (!stopped && (ownership.ownedThreadIds()?.length ?? 0) > 0) {
        backstop = setInterval(pokeAll, RETIRE_RELEASE_BACKSTOP_MS);
        backstop.unref?.();
      }
      return ownership.ownedThreadIds() ?? [];
    },
    unretire() {
      clearBackstop();
      if (!ownership.retiring) return;
      ownership.unretire();
      logger.info("agent-host: no longer retiring; every thread is served here again");
      seams.onUnretired?.();
    },
    poke,
    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    stop() {
      stopped = true;
      clearBackstop();
    }
  };
}
