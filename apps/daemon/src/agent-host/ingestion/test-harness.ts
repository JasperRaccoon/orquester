/**
 * Deterministic seams for the ingestion tests (§9: wait on events, never on
 * sleeps). Nothing here is used at runtime — it exists so every batching
 * threshold, every coalescing window and every flush point is asserted against
 * a clock and a timer queue the test drives by hand.
 */

import type { AppendableDomainEvent, LivenessRegistry } from "../services.ts";
import type { BackgroundLiveness, RuntimeEvent } from "@orquester/api/agent-chat";

import type { Clock, IdGen } from "../adapter.ts";

export class FakeClock implements Clock {
  #ms: number;

  constructor(startIso = "2026-09-21T10:00:00.000Z") {
    this.#ms = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  nowIso(): string {
    return new Date(this.#ms).toISOString();
  }

  advance(ms: number): void {
    this.#ms += ms;
  }

  get ms(): number {
    return this.#ms;
  }
}

interface ScheduledTimer {
  handle: number;
  dueAt: number;
  fn: () => void;
}

/** A timer queue slaved to a {@link FakeClock}. `advance` runs what came due. */
export class FakeTimers {
  readonly #clock: FakeClock;
  #next = 1;
  #timers: ScheduledTimer[] = [];

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const handle = this.#next++;
    this.#timers.push({ handle, dueAt: this.#clock.ms + ms, fn });
    return handle;
  };

  readonly clearTimer = (handle: unknown): void => {
    this.#timers = this.#timers.filter((timer) => timer.handle !== handle);
  };

  get pending(): number {
    return this.#timers.length;
  }

  /** Move the clock and fire every timer that came due, earliest first. */
  advance(ms: number): void {
    this.#clock.advance(ms);
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.dueAt <= this.#clock.ms)
        .sort((a, b) => a.dueAt - b.dueAt || a.handle - b.handle);
      if (due.length === 0) {
        return;
      }
      const next = due[0]!;
      this.#timers = this.#timers.filter((timer) => timer.handle !== next.handle);
      next.fn();
    }
  }
}

export function counterIdGen(prefix = "e"): IdGen {
  let n = 0;
  return {
    eventId: () => `${prefix}${++n}`,
    messageId: (p: string) => `${p}${++n}`,
    uuid: () => `${prefix}-uuid-${++n}`
  };
}

export interface RecordedBatch {
  threadId: string;
  events: AppendableDomainEvent[];
}

/** A sink that records batches and preserves the order it was called in. */
export class RecordingSink {
  readonly batches: RecordedBatch[] = [];

  readonly sink = async (
    threadId: string,
    events: AppendableDomainEvent[]
  ): Promise<void> => {
    this.batches.push({ threadId, events: [...events] });
  };

  events(): AppendableDomainEvent[] {
    return this.batches.flatMap((batch) => batch.events);
  }

  types(): string[] {
    return this.events().map((event) => event.type);
  }

  ofType<TType extends AppendableDomainEvent["type"]>(
    type: TType
  ): Extract<AppendableDomainEvent, { type: TType }>[] {
    return this.events().filter((event) => event.type === type) as Extract<
      AppendableDomainEvent,
      { type: TType }
    >[];
  }

  activities(): Extract<AppendableDomainEvent, { type: "thread.activity-appended" }>[] {
    return this.ofType("thread.activity-appended");
  }

  activityKinds(): string[] {
    return this.activities().map((event) => event.payload.activity.activityKind);
  }

  messages(): Extract<AppendableDomainEvent, { type: "thread.message-sent" }>[] {
    return this.ofType("thread.message-sent");
  }

  reset(): void {
    this.batches.length = 0;
  }
}

/** Records what ingestion fed it; the real registry is W1's. */
export class RecordingLiveness implements LivenessRegistry {
  readonly observed: RuntimeEvent[] = [];
  readonly cleared: string[] = [];

  observe(event: RuntimeEvent): void {
    this.observed.push(event);
  }

  liveness(): BackgroundLiveness | null {
    return null;
  }

  liveAgentCount(): number {
    return 0;
  }

  clear(threadId: string): void {
    this.cleared.push(threadId);
  }
}

let eventCounter = 0;

/** Build a runtime event with sane defaults; every test overrides what it cares about. */
export function runtimeEvent<TType extends RuntimeEvent["type"]>(
  type: TType,
  payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<RuntimeEvent, "type" | "payload">> = {}
): Extract<RuntimeEvent, { type: TType }> {
  return {
    eventId: `re${++eventCounter}`,
    threadId: "t1",
    createdAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
    type,
    payload
  } as Extract<RuntimeEvent, { type: TType }>;
}

export function resetRuntimeEventCounter(): void {
  eventCounter = 0;
}

/**
 * Let the per-thread sink chain run. `advance()` fires a batch timer
 * synchronously, but the sink call it triggers is a microtask — this is the
 * "wait on the event, not on a sleep" seam for that hop.
 */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
