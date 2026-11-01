/**
 * Agent host — which threads this host may touch (spec 2026-11-01 P2.3 R15–R21, P2.5 I1/I2/I4).
 *
 * Every thread has exactly one writing host. A host knows two kinds of thread it does NOT own:
 *
 * - **foreign** at boot: the `{ "threadIds": string[] }` file the daemon names in
 *   `ORQUESTER_AGENT_HOST_FOREIGN_THREADS` — threads a retiring host still serves. They stay
 *   foreign until `POST /threads/:id/adopt` takes them in ({@link ThreadOwnership.adopt}).
 * - **released** while retiring: `POST /retire` keeps only the threads with live work (the owned
 *   set, {@link ThreadOwnership.retire}); every other thread — loaded or not, known or not — is
 *   foreign from then on, and each owned thread joins them once it is released at its first idle
 *   moment ({@link ThreadOwnership.beginRelease}). `POST /unretire` takes them all back.
 *
 * A foreign thread is never folded, written, reconciled, swept, indexed, or given a provider
 * session, and every request naming it answers 409 `THREAD_NOT_OWNED` ({@link enter}). A thread
 * being released still counts as owned — its provider session is being closed and its last rows
 * written (I4: the session is closed BEFORE the thread leaves `ownedThreadIds`) — but a request
 * that arrives meanwhile waits for the release, then answers as the release left it.
 *
 * Requests in flight are counted per thread ({@link enter}, {@link track}): a thread with one is
 * never released, and its end is a moment the retiring host looks at the thread again
 * ({@link onSettled}).
 */

import { AgentChatCommandError } from "./errors.ts";

/** A thread id the host's routes accept (`server/http-server.ts`): a directory name, never a path. */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * P2.3 R15: the foreign-threads file, `{ "threadIds": string[] }`. Anything else throws — a host
 * that cannot tell which threads another host serves must not boot and guess.
 */
export function parseForeignThreadsFile(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  const threadIds =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { threadIds?: unknown }).threadIds
      : undefined;
  if (!Array.isArray(threadIds) || !threadIds.every((id) => typeof id === "string" && THREAD_ID_PATTERN.test(id))) {
    throw new Error('The foreign-threads file must be { "threadIds": [<thread id>, …] }.');
  }
  return threadIds as string[];
}

/** The 409 every route answers for a thread another host owns (P2.3 R16, R19). */
export function threadNotOwned(threadId: string): AgentChatCommandError {
  return new AgentChatCommandError(
    "THREAD_NOT_OWNED",
    `Thread '${threadId}' belongs to another agent host.`,
    { threadId }
  );
}

/** The 409 a retiring host answers a thread creation with (P2.3 R18). */
export function hostRetiring(): AgentChatCommandError {
  return new AgentChatCommandError(
    "HOST_RETIRING",
    "This agent host is retiring and takes no new threads."
  );
}

export interface ThreadOwnership {
  /** True between an accepted `/retire` and an `/unretire`. */
  readonly retiring: boolean;
  /**
   * True while another host may be serving threads beside this one — this host retires, or it
   * booted with foreign threads it has not adopted yet. Shared files then need a merge, not an
   * overwrite (the receipts ring).
   */
  shared(): boolean;
  /** Owned by another host: boot-foreign and not adopted, or (retiring) released. */
  isForeign(threadId: string): boolean;
  /** While retiring: the threads this host still owns, releasing ones included. Else null. */
  ownedThreadIds(): string[] | null;
  /**
   * R17: take a foreign thread in — owned at once (the adoption's own reconcile writes it), while
   * requests for it wait for the returned finisher. Null when it was not foreign (nothing to do).
   * Throws `HOST_RETIRING` on a retiring host: only the primary adopts.
   */
  adopt(threadId: string): (() => void) | null;
  /** R18: retire, keeping `owned`. Repeatable: a second call keeps the current owned set. */
  retire(owned: Iterable<string>): string[];
  /** R21: stop retiring; every released thread is owned again (the boot-foreign ones stay foreign). */
  unretire(): void;
  /**
   * R19: start releasing an owned thread, when nothing is in flight for it. Answers the finisher —
   * `true` makes the thread foreign, `false` keeps it owned (the release found live work) — or
   * null when the thread cannot be released now (not retiring, not owned, already releasing, a
   * request in flight). Requests arriving meanwhile wait for the finisher.
   */
  beginRelease(threadId: string): ((released: boolean) => void) | null;
  /** True while {@link beginRelease}'s finisher has not run for the thread. */
  releasing(threadId: string): boolean;
  /**
   * The gate of one request for a thread: waits out a release or an adoption in flight, then
   * throws `THREAD_NOT_OWNED` for a foreign thread, else counts the request in flight until the
   * returned exit runs. `readsForeign`: a request that only READS a foreign thread (a fork of a
   * parent another host serves) passes uncounted instead.
   */
  enter(threadId: string, options?: { readsForeign?: boolean }): Promise<() => void>;
  /** Count internal work (an effect) for an owned thread while `work` runs. */
  track<T>(threadId: string, work: Promise<T>): Promise<T>;
  /** Requests and tracked work in flight for the thread. */
  inFlight(threadId: string): number;
  /** Every thread with a request or tracked work in flight. */
  inFlightThreadIds(): string[];
  /** Told whenever a thread's last request or tracked work ends. */
  onSettled(listener: (threadId: string) => void): void;
}

export function createThreadOwnership(input: { foreignThreadIds?: Iterable<string> } = {}): ThreadOwnership {
  /** Boot-foreign threads not adopted yet. */
  const foreign = new Set<string>(input.foreignThreadIds ?? []);
  /** While retiring: the threads still owned. Null while not retiring. */
  let owned: Set<string> | null = null;
  const releases = new Map<string, Promise<void>>();
  const counts = new Map<string, number>();
  const listeners: Array<(threadId: string) => void> = [];

  /** A release or an adoption of the thread is under way: requests wait for its finisher. */
  const gate = (threadId: string): (() => void) => {
    let open!: () => void;
    releases.set(
      threadId,
      new Promise<void>((resolve) => {
        open = resolve;
      })
    );
    return () => {
      releases.delete(threadId);
      open();
    };
  };

  const isForeign = (threadId: string): boolean =>
    foreign.has(threadId) || (owned !== null && !owned.has(threadId));

  const exitOnce = (threadId: string): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (counts.get(threadId) ?? 1) - 1;
      if (left > 0) {
        counts.set(threadId, left);
        return;
      }
      counts.delete(threadId);
      for (const listener of listeners) {
        try {
          listener(threadId);
        } catch {
          // A listener's failure never fails the request it follows.
        }
      }
    };
  };

  const count = (threadId: string): (() => void) => {
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
    return exitOnce(threadId);
  };

  return {
    get retiring() {
      return owned !== null;
    },
    shared: () => owned !== null || foreign.size > 0,
    isForeign,
    ownedThreadIds: () => (owned === null ? null : [...owned].sort()),
    adopt(threadId) {
      if (owned !== null) throw hostRetiring();
      if (!foreign.delete(threadId)) return null;
      return gate(threadId);
    },
    retire(keep) {
      if (owned === null) {
        owned = new Set([...keep].filter((threadId) => !foreign.has(threadId)));
      }
      return [...owned].sort();
    },
    unretire() {
      owned = null;
    },
    beginRelease(threadId) {
      if (owned === null || !owned.has(threadId) || releases.has(threadId) || counts.has(threadId)) {
        return null;
      }
      const finish = gate(threadId);
      return (released) => {
        if (released) owned?.delete(threadId);
        finish();
      };
    },
    releasing: (threadId) => releases.has(threadId),
    async enter(threadId, options) {
      for (let release = releases.get(threadId); release !== undefined; release = releases.get(threadId)) {
        await release;
      }
      if (isForeign(threadId)) {
        if (options?.readsForeign === true) return () => undefined;
        throw threadNotOwned(threadId);
      }
      return count(threadId);
    },
    async track(threadId, work) {
      const exit = count(threadId);
      try {
        return await work;
      } finally {
        exit();
      }
    },
    inFlight: (threadId) => counts.get(threadId) ?? 0,
    inFlightThreadIds: () => [...counts.keys()],
    onSettled(listener) {
      listeners.push(listener);
    }
  };
}

/**
 * The store's per-thread writes, by method: where each names its thread. `logRawFrame` is dropped
 * rather than refused (a diagnostic, never awaited); every other write of a foreign thread throws
 * `THREAD_NOT_OWNED` before it touches the disk.
 */
const THREAD_WRITES: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
  append: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  saveFoldSnapshot: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  saveHead: (args) => (args[0] as { id?: unknown } | undefined)?.id,
  upsertSessionBinding: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  putReceipt: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  putAttachment: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  pruneAttachments: (args) => (args[0] as { threadId?: unknown } | undefined)?.threadId,
  deleteThread: (args) => args[0],
  copyPages: (args) => args[1],
  logRawFrame: (args) => args[0],
  // `launch.json` and `fork-handoff.json` (`LaunchConfigStore`, `ForkHandoffStore`): `save(threadId, …)`.
  save: (args) => args[0]
};

/**
 * I1 (spec 2026-11-01 P2.5) at the one place every thread write passes: the store, wrapped so a
 * write naming a thread this host does not own never reaches its files — whatever path asked for
 * it (a timer that still holds a released runtime, a late adapter row, a route). Reads pass
 * through untouched. A thread being released is still owned, so its last rows land.
 */
export function guardThreadWrites<S extends object>(store: S, ownership: Pick<ThreadOwnership, "isForeign">): S {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      const call = value as (...args: unknown[]) => unknown;
      const threadOf = THREAD_WRITES[property];
      if (threadOf === undefined) return call.bind(target);
      return (...args: unknown[]): unknown => {
        const threadId = threadOf(args);
        if (typeof threadId === "string" && ownership.isForeign(threadId)) {
          if (property === "logRawFrame") return undefined;
          return Promise.reject(threadNotOwned(threadId));
        }
        return call.apply(target, args);
      };
    }
  });
}
