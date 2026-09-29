/**
 * Grok adapter — the CLI's prompt queue, as `_x.ai/queue/changed` reports it,
 * and the turns the CLI's own prompts (its wakes) get from it: which running
 * prompt is ours and which the CLI started on its own, the wakes waiting for
 * the turn open before them to settle, and the frames that wait with them.
 *
 * One rule, shared by the session (`session.ts`) and the capture-replay
 * driver (`testing/capture-driver.ts`) — the same {@link GrokWakes}, so the
 * two cannot drift. Captured on 2026-09-25 (the Grok fixtures README,
 * observation 40).
 */

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { GrokNormalizer } from "./normalize.ts";

/** How many prompt ids are remembered, oldest forgotten first; memory only. */
const PROMPT_IDS_REMEMBERED = 256;

/**
 * How many frames wait for a waiting wake's turn ({@link GrokWakes.offer}).
 * The wait normally lasts until the turn open before it settles — 15 ms and
 * one hook frame in fixture 20 — so this bound only matters for a long wait
 * (a steer, or a wake that starts during a `session/set_model` round trip):
 * past it the held frames join the open turn, in order. Nothing is dropped.
 */
const HELD_FRAMES_MAX = 256;

/**
 * A prompt the CLI started itself: a background subagent's end
 * (`subagent-completed-<id>`), a monitor's line (`notifications-<uuid>`) or a
 * monitor's end (`task-completed-<id>`).
 */
export interface CliPrompt {
  readonly promptId: string;
  /**
   * The monitors whose lines the prompt carries — the `task_id` of every
   * `<monitor-event … task_id="…">` block in its `runningText` (fixture 20).
   * The wake IS those monitors reporting, just before its turn starts.
   */
  readonly monitorTaskIds: readonly string[];
}

/** What one parent-session `_x.ai/queue/changed` says. */
type QueueObservation =
  /** One of ours is running (it was listed first): the turn claims it. */
  | { readonly kind: "ours"; readonly promptId: string }
  /** The CLI started a prompt of its own, first seen now. */
  | { readonly kind: "cli"; readonly prompt: CliPrompt }
  /** Nothing is running: the first listed entry, if any, may claim the turn. */
  | { readonly kind: "queued"; readonly firstListed?: string }
  /** A running prompt already known — nothing new. */
  | { readonly kind: "known" };

/** Any attribute order: the id is read wherever the block names it. */
const MONITOR_EVENT_RE = /<monitor-event\b[^>]*\btask_id="([^"]+)"/g;

/** A monitor's line wakes the agent under this prompt id prefix (fixture 20). */
const MONITOR_LINE_PROMPT_PREFIX = "notifications-";

/** The monitors a CLI prompt's `runningText` carries lines of. */
function monitorTaskIdsIn(runningText: unknown): string[] {
  if (typeof runningText !== "string") {
    return [];
  }
  return [...new Set([...runningText.matchAll(MONITOR_EVENT_RE)].map((match) => match[1]!))];
}

/**
 * The prompt a frame of the PARENT session names: a `session/update`'s
 * `_meta.promptId`, a private-channel update's own `prompt_id` (hooks,
 * `turn_completed`, `last_turn_summary`) else its `_meta.promptId`.
 */
function framePromptId(params: unknown): string | undefined {
  const record = params as { update?: { prompt_id?: unknown }; _meta?: { promptId?: unknown } } | null;
  const own = record?.update?.prompt_id;
  if (typeof own === "string" && own.length > 0) {
    return own;
  }
  const meta = record?._meta?.promptId;
  return typeof meta === "string" && meta.length > 0 ? meta : undefined;
}

/**
 * Whether a frame's `sessionId` is the thread's own ACP session rather than a
 * subagent's child session — which streams under its own id (fixture 15). A
 * frame naming no session, or one read before `session/new` answered, is the
 * parent's.
 */
export function isParentSessionId(parentSessionId: string, sessionId: unknown): boolean {
  return typeof sessionId !== "string" || parentSessionId.length === 0 || sessionId === parentSessionId;
}

function rememberBounded(set: Set<string>, value: string): void {
  set.delete(value);
  set.add(value);
  if (set.size > PROMPT_IDS_REMEMBERED) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

/** A CLI prompt announced while a turn was open, waiting for it to settle. */
interface PendingWake {
  readonly prompt: CliPrompt;
  /**
   * Its `turn_completed` came — held or not: the CLI runs it no longer, so a
   * cancel sent now does not end it ({@link GrokPromptQueue.newestRunning}).
   */
  finished: boolean;
  /**
   * Its frames stopped waiting: they joined the open turn, in order (too many
   * held, or a card opening on that turn). It still gets a turn of its
   * own when that turn settles, for whatever it streams after — unless it
   * finished before, when there is nothing left to give one.
   */
  merged: boolean;
}

/**
 * The prompt queue's bookkeeping. **The rule**: every prompt a client sends
 * is first LISTED in `entries`, then named `runningPromptId`; a prompt the
 * CLI starts itself goes straight to `runningPromptId`, never listed (every
 * capture, fixtures 15–23). And the CLI runs one prompt at a time, in order:
 * a CLI prompt announced while a turn of ours is still settling — fixture
 * 20's first monitor line, 15 ms before the user's prompt's RPC result — is
 * already the one running, and waits here for that turn to settle.
 */
class GrokPromptQueue {
  private readonly listed = new Set<string>();
  private readonly cli = new Set<string>();
  private readonly pending: PendingWake[] = [];

  /** One `_x.ai/queue/changed` of the parent session. */
  observe(params: unknown): QueueObservation {
    const record = params as
      | { entries?: ReadonlyArray<{ id?: unknown }>; runningPromptId?: unknown; runningText?: unknown }
      | null;
    for (const entry of record?.entries ?? []) {
      if (typeof entry.id === "string") {
        rememberBounded(this.listed, entry.id);
      }
    }
    const running = record?.runningPromptId;
    if (typeof running === "string") {
      if (this.listed.has(running)) {
        return { kind: "ours", promptId: running };
      }
      if (this.cli.has(running)) {
        return { kind: "known" };
      }
      rememberBounded(this.cli, running);
      return { kind: "cli", prompt: { promptId: running, monitorTaskIds: monitorTaskIdsIn(record?.runningText) } };
    }
    const first = record?.entries?.[0]?.id;
    return typeof first === "string" ? { kind: "queued", firstListed: first } : { kind: "queued" };
  }

  /** A prompt the CLI started itself — never a turn of ours to claim. */
  isCliPrompt(promptId: string): boolean {
    return this.cli.has(promptId);
  }

  /** Hold a CLI prompt until the turn now open settles. */
  pend(prompt: CliPrompt): void {
    this.pending.push({ prompt, finished: false, merged: false });
    this.pending.splice(0, Math.max(0, this.pending.length - PROMPT_IDS_REMEMBERED));
  }

  /** The next CLI prompt waiting for a turn, taken. */
  takePending(): CliPrompt | undefined {
    return this.pending.shift()?.prompt;
  }

  /** The waiting CLI prompt a frame names, if it waits. */
  waiting(promptId: string): PendingWake | undefined {
    return this.pending.find((wake) => wake.prompt.promptId === promptId);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  pendingIds(): string[] {
    return this.pending.map((wake) => wake.prompt.promptId);
  }

  /** Forget a waiting CLI prompt (a cancel ended it, or it ended while merged). */
  dropPending(promptId: string): boolean {
    const index = this.pending.findIndex((wake) => wake.prompt.promptId === promptId);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  /**
   * The CLI prompt a `session/cancel` sent now would end: the NEWEST waiting
   * one that has not finished — the CLI runs it, one prompt at a time
   * (fixtures 05, 23: a cancel ends the running prompt; 21: with none running
   * it ends none). One whose `turn_completed` already came is over, and keeps
   * its turn.
   */
  newestRunning(): CliPrompt | undefined {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const wake = this.pending[index]!;
      if (!wake.finished) {
        return wake.prompt;
      }
    }
    return undefined;
  }

  /** Every waiting prompt's frames stop waiting ({@link PendingWake.merged}). */
  mergeAll(): void {
    for (const wake of this.pending) {
      wake.merged = true;
    }
  }

  clearPending(): void {
    this.pending.length = 0;
  }
}

/** What a session (or the capture-replay driver) does for {@link GrokWakes}. */
interface WakeHost {
  /** A turn is open and unsettled: a CLI prompt announced now waits for it. */
  turnOpen(): boolean;
  /** Open the CLI prompt's own turn (`turn.started`); its re-arms and held frames follow. */
  openTurn(prompt: CliPrompt): void;
  /** Rows the coordinator makes: the monitors a wake re-arms. */
  emit(events: readonly RuntimeEvent[]): void;
  /** A prompt of ours seen running or first in the queue — the open turn's provider id. */
  notePrompt(promptId: string): void;
  debug(message: string, detail: Record<string, unknown>): void;
}

interface WakeOptions {
  /** The thread's own ACP session id; `""` until `session/new` answers. */
  parentSessionId(): string;
}

/**
 * The turns the CLI's own prompts get, and the frames that wait for them.
 *
 * A CLI prompt announced while no turn is open gets its turn at once. One
 * announced while a turn is still open — ours settling (fixture 20), or ours
 * continued by a steer — waits for that turn to settle, and so do its frames:
 * **a frame of the parent that names a waiting prompt starts a hold, and
 * every frame after it — of any session, naming anything or nothing — queues
 * behind it** until the waiting prompt's turn opens, when they are handed
 * back through the same gate in arrival order. The order is the point: a
 * woken parent's `spawn_subagent` call names its prompt, and the
 * `subagent_spawned` that follows names none; handled first, it started a
 * second, phantom agent. A held `turn_completed` is its prompt's end.
 *
 * **A held frame is never discarded.** When a waiting prompt can no longer
 * get its own turn, or its frames can wait no longer, what is held joins the
 * open turn, in order — merged, but kept:
 * - too many held ({@link HELD_FRAMES_MAX}), or a card opening on the open
 *   turn — the session's call ({@link merge}): the waiting prompts keep a
 *   turn of their own for what they stream after the open one settles,
 *   unless they finished by then;
 * - a cancel ({@link cancelEnds}): the newest waiting prompt still running
 *   ends with it, and gets no turn;
 * - our own prompt running ({@link queueChanged}): every waiting prompt is
 *   over, and none can get a turn before ours, which it continues;
 * - the session stopping or its process exiting ({@link drop}).
 */
export class GrokWakes {
  private readonly queue = new GrokPromptQueue();
  private held: Array<() => void> = [];

  constructor(
    private readonly normalizer: Pick<GrokNormalizer, "rearmMonitors">,
    private readonly host: WakeHost,
    private readonly options: WakeOptions
  ) {}

  /** A prompt the CLI started itself — never a turn of ours to claim. */
  isCliPrompt(promptId: string): boolean {
    return this.queue.isCliPrompt(promptId);
  }

  /**
   * Whether the prompt the CLI runs now is one of its own still waiting for
   * a turn — it runs one prompt at a time, so a waiting prompt that has not
   * finished is the one running (fixture 20's window, while ours settles).
   */
  waitingPromptRuns(): boolean {
    return this.queue.newestRunning() !== undefined;
  }

  /** One `_x.ai/queue/changed` of the parent session. */
  queueChanged(params: unknown): void {
    const seen = this.queue.observe(params);
    switch (seen.kind) {
      case "ours":
        // Our prompt runs, so every prompt of the CLI's own still waiting is
        // over (one prompt at a time) — and none can get a turn before ours,
        // which this prompt continues (a steer; a prompt sent after a wake
        // started during the `set_model` round trip).
        this.drop("our prompt runs while the CLI's own prompts wait for a turn");
        this.host.notePrompt(seen.promptId);
        return;
      case "cli":
        if (this.host.turnOpen()) {
          this.queue.pend(seen.prompt);
        } else {
          this.openWake(seen.prompt);
        }
        return;
      case "queued":
        if (seen.firstListed !== undefined) {
          this.host.notePrompt(seen.firstListed);
        }
        return;
      case "known":
        return;
    }
  }

  /**
   * A frame, before it is handled: `true` when it waits — or already joined
   * the open turn in a flush — and must not be handled now. `replay` hands
   * it back to the same handler, which offers it here again.
   */
  offer(params: unknown, replay: () => void): boolean {
    const record = params as { sessionId?: unknown; update?: Record<string, unknown> } | null;
    const promptId = isParentSessionId(this.options.parentSessionId(), record?.sessionId)
      ? framePromptId(params)
      : undefined;
    const waiting = promptId === undefined ? undefined : this.queue.waiting(promptId);
    const ends =
      waiting !== undefined &&
      record?.update?.["sessionUpdate"] === "turn_completed" &&
      record.update["prompt_id"] === promptId;
    if (ends) {
      waiting.finished = true;
    }
    if (this.held.length > 0 || (waiting !== undefined && !waiting.merged)) {
      this.held.push(replay);
      if (this.held.length > HELD_FRAMES_MAX) {
        this.merge("more frames than a hold keeps");
      }
      return true;
    }
    if (ends) {
      // Its end, while its frames join the open turn: nothing is left to
      // give a turn of its own.
      this.queue.dropPending(promptId!);
    }
    return false;
  }

  /** The open turn settled: the next waiting CLI prompt gets its turn. */
  turnSettled(): void {
    const next = this.queue.takePending();
    if (next === undefined) {
      this.release();
      return;
    }
    this.openWake(next);
  }

  /**
   * About to send `session/cancel`: the newest waiting CLI prompt still
   * running is the one the CLI runs, so the cancel ends IT — it gets no turn
   * (opened after ours settles, it would be an empty turn the cancel's
   * `turn_completed` then settles), and what it streamed joins the open turn.
   */
  cancelEnds(): void {
    const running = this.queue.newestRunning();
    if (running === undefined) {
      return;
    }
    this.queue.dropPending(running.promptId);
    this.host.debug("grok: a cancel ended the CLI's own prompt before its turn opened", {
      promptId: running.promptId,
      heldFrames: this.held.length
    });
    this.release();
  }

  /**
   * The held frames can wait no longer: they join the open turn, in order,
   * and the waiting prompts stop holding theirs back. Each still gets a turn
   * of its own when the open one settles, unless it finished by then.
   */
  merge(reason: string): void {
    if (this.held.length === 0) {
      return;
    }
    this.host.debug(`grok: ${reason}; the frames held for a waiting prompt join the open turn`, {
      promptIds: this.queue.pendingIds(),
      heldFrames: this.held.length
    });
    this.queue.mergeAll();
    this.release();
  }

  /**
   * No waiting CLI prompt can get a turn of its own any more: they are
   * forgotten, and every held frame joins the open turn, in order.
   */
  drop(reason: string): void {
    if (!this.queue.hasPending() && this.held.length === 0) {
      return;
    }
    this.host.debug(`grok: ${reason}; the frames held for a waiting prompt join the open turn`, {
      promptIds: this.queue.pendingIds(),
      heldFrames: this.held.length
    });
    this.queue.clearPending();
    this.release();
  }

  /** Every held frame through the gate again, in arrival order. */
  private release(): void {
    const frames = this.held;
    this.held = [];
    for (const replay of frames) {
      replay();
    }
  }

  /**
   * A turn for the CLI's own prompt. The monitors whose lines it carries are
   * re-armed inside it: the lines arrived just before it, and the liveness
   * registry's turn-boundary sweep would otherwise read them as silent
   * through it ({@link GrokNormalizer.rearmMonitors}). Then the frames held
   * for it are handed back.
   */
  private openWake(prompt: CliPrompt): void {
    this.host.openTurn(prompt);
    const rearmed = this.normalizer.rearmMonitors(prompt.monitorTaskIds);
    this.host.emit(rearmed);
    if (prompt.promptId.startsWith(MONITOR_LINE_PROMPT_PREFIX) && rearmed.length === 0) {
      // A line's wake with no live monitor to name: the monitor ended first,
      // or the `runningText` format moved — visible here, not silent.
      this.host.debug("grok: a monitor line's wake names no live monitor", {
        promptId: prompt.promptId,
        monitorTaskIds: prompt.monitorTaskIds
      });
    }
    this.release();
  }
}
