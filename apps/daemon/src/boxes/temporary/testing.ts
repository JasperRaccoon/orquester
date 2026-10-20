/**
 * Test doubles for the temporary-box backend: an in-memory {@link TemporaryBoxes} (records and
 * change events, no provider), a manual clock whose timers fire only when a test says so, and a
 * box summary builder.
 */

import type { BoxDestroyedReason, BoxSummary } from "@orquester/api";

import type { CreateTemporaryBoxInput, TemporaryBoxes } from "./contract.ts";
import type { TemporaryBoxClock } from "./tools.ts";

export function boxSummary(overrides: Partial<BoxSummary> = {}): BoxSummary {
  return {
    id: "box-1",
    purpose: "temporary",
    kind: "linux",
    provider: "hetzner",
    providerLabel: "Hetzner",
    region: "fsn1",
    regionLabel: "Falkenstein",
    size: "cx22",
    sizeLabel: "CX22",
    image: null,
    os: "linux",
    arch: "x64",
    state: "ready",
    stateReason: null,
    destroyedReason: null,
    hourlyUsd: 0.006,
    estimatedCostUsd: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    readyAt: "2026-10-20T00:01:00.000Z",
    deadlineAt: "2026-10-20T02:00:00.000Z",
    destroyedAt: null,
    connected: true,
    lastSeenAt: null,
    project: null,
    threadId: "chat-a",
    purposeNote: "test",
    setup: [],
    ...overrides
  };
}

/** The box service, in memory: `createTemporaryBox` records a `provisioning` box; `update` moves it. */
export class FakeTemporaryBoxes implements TemporaryBoxes {
  readonly boxes = new Map<string, BoxSummary>();
  readonly created: CreateTemporaryBoxInput[] = [];
  readonly destroyed: { boxId: string; reason: BoxDestroyedReason }[] = [];
  private readonly listeners = new Set<(boxId: string) => void>();
  private next = 0;
  /** Set to make the next create fail with this error. */
  createError: Error | null = null;
  /** Runs inside `createTemporaryBox` before it resolves (to race a chat close). */
  onCreate: (() => void) | null = null;

  add(box: BoxSummary): this {
    this.boxes.set(box.id, box);
    return this;
  }

  update(boxId: string, patch: Partial<BoxSummary>): void {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`no box ${boxId}`);
    this.boxes.set(boxId, { ...box, ...patch });
    this.emit(boxId);
  }

  async createTemporaryBox(input: CreateTemporaryBoxInput): Promise<BoxSummary> {
    if (this.createError) throw this.createError;
    this.created.push(input);
    const box = boxSummary({
      id: `tmp-${(this.next += 1)}`,
      kind: input.kind,
      provider: input.provider ?? "hetzner",
      region: input.region ?? "fsn1",
      size: input.size ?? "cx22",
      state: "provisioning",
      connected: false,
      os: null,
      arch: null,
      readyAt: null,
      threadId: input.threadId,
      purposeNote: input.purposeNote
    });
    this.boxes.set(box.id, box);
    this.onCreate?.();
    this.emit(box.id);
    return box;
  }

  async destroyBox(boxId: string, reason: BoxDestroyedReason): Promise<void> {
    this.destroyed.push({ boxId, reason });
    if (this.boxes.has(boxId)) this.update(boxId, { state: "destroyed", destroyedReason: reason, connected: false });
  }

  list(): BoxSummary[] {
    return [...this.boxes.values()];
  }

  get(boxId: string): BoxSummary | undefined {
    return this.boxes.get(boxId);
  }

  onChange(listener: (boxId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(boxId: string): void {
    for (const listener of [...this.listeners]) listener(boxId);
  }
}

/** Timers fire only through {@link fire} / {@link advance}; `now` moves only with `advance`. */
export class ManualClock implements TemporaryBoxClock {
  private time = 1_000_000;
  private id = 0;
  private readonly timers = new Map<number, { fn: () => void; at: number; ms: number }>();

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): unknown {
    this.id += 1;
    this.timers.set(this.id, { fn, at: this.time + ms, ms });
    return this.id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Pending timers' delays, in set order. */
  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.ms);
  }

  /** Move time on and run every timer now due. */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time && this.timers.has(id)) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }

  /** Run the pending timers set with delay `ms` (without moving time). */
  fire(ms: number): number {
    let fired = 0;
    for (const [id, timer] of [...this.timers]) {
      if (timer.ms === ms && this.timers.has(id)) {
        this.timers.delete(id);
        timer.fn();
        fired += 1;
      }
    }
    return fired;
  }
}
