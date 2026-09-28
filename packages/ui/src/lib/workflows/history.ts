/**
 * The workflow editor's undo / redo (workflows spec §7.2): snapshots of the
 * whole definition, 100 steps, with bursts coalesced into one step.
 *
 * A snapshot is the definition BEFORE a change (`record`), so undo hands back
 * exactly what the canvas showed before it. A burst — every frame of a drag,
 * every keystroke of a field — records only its first "before": a change with
 * the same coalescing key within `coalesceMs` of the previous one adds no step.
 * A key of `null` never coalesces. Snapshots are treated as immutable values
 * (the editor never mutates a definition in place), so they are kept by
 * reference.
 *
 * Pure and clock-free: the caller passes the time.
 */

export const HISTORY_LIMIT = 100;
/** A typing burst or a drag: changes this close together with the same key are one step. */
export const HISTORY_COALESCE_MS = 1_000;

export interface HistoryOptions {
  limit?: number;
  coalesceMs?: number;
}

export class SnapshotHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly limit: number;
  private readonly coalesceMs: number;

  constructor(options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? HISTORY_LIMIT);
    this.coalesceMs = Math.max(0, options.coalesceMs ?? HISTORY_COALESCE_MS);
  }

  /**
   * Record `before`, the state a change is about to replace. Returns whether a
   * new step was added (false when it joined the running burst).
   */
  record(before: T, key: string | null, at: number): boolean {
    const joins =
      key !== null && key === this.lastKey && at - this.lastAt <= this.coalesceMs && this.past.length > 0;
    this.lastKey = key;
    this.lastAt = at;
    // Any new change forks history: what was undone can no longer be redone.
    this.future = [];
    if (joins) return false;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    return true;
  }

  /** End the running burst: the next change is a step of its own even with the same key. */
  seal(): void {
    this.lastKey = null;
  }

  /** The state to show instead of `current`, or null when there is nothing to undo. */
  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    this.seal();
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.seal();
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get size(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.seal();
  }
}
