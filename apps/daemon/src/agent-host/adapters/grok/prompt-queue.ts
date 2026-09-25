/**
 * Grok adapter — the CLI's prompt queue, as `_x.ai/queue/changed` reports it:
 * which running prompt is ours and which the CLI started on its own (a wake),
 * the wakes still waiting for a turn, and which prompt a frame names.
 *
 * One rule, shared by the session (`session.ts`) and the capture-replay
 * driver (`testing/capture-driver.ts`) so the two cannot drift. Captured on
 * 2026-09-25 (the Grok fixtures README, observation 40).
 */

/** How many prompt ids are remembered, oldest forgotten first; memory only. */
export const PROMPT_IDS_REMEMBERED = 256;

/**
 * A prompt the CLI started itself: a background subagent's end
 * (`subagent-completed-<id>`), a monitor's line (`notifications-<uuid>`) or a
 * monitor's end (`task-completed-<id>`).
 */
export interface CliPrompt {
  readonly promptId: string;
  /**
   * The monitors whose lines the prompt carries — the `task_id` of every
   * `<monitor-event task_id="…">` block in its `runningText` (fixture 20).
   * The wake IS those monitors reporting, just before its turn starts.
   */
  readonly monitorTaskIds: readonly string[];
}

/** What one parent-session `_x.ai/queue/changed` says. */
export type QueueObservation =
  /** One of ours is running (it was listed first): the turn claims it. */
  | { readonly kind: "ours"; readonly promptId: string }
  /** The CLI started a prompt of its own, first seen now. */
  | { readonly kind: "cli"; readonly prompt: CliPrompt }
  /** Nothing is running: the first listed entry, if any, may claim the turn. */
  | { readonly kind: "queued"; readonly firstListed?: string }
  /** A running prompt already known — nothing new. */
  | { readonly kind: "known" };

const MONITOR_EVENT_RE = /<monitor-event\s+task_id="([^"]+)"/g;

/** The monitors a CLI prompt's `runningText` carries lines of. */
export function monitorTaskIdsIn(runningText: unknown): string[] {
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
export function framePromptId(params: unknown): string | undefined {
  const record = params as { update?: { prompt_id?: unknown }; _meta?: { promptId?: unknown } } | null;
  const own = record?.update?.prompt_id;
  if (typeof own === "string" && own.length > 0) {
    return own;
  }
  const meta = record?._meta?.promptId;
  return typeof meta === "string" && meta.length > 0 ? meta : undefined;
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

/**
 * The prompt queue's bookkeeping. **The rule**: every prompt a client sends
 * is first LISTED in `entries`, then named `runningPromptId`; a prompt the
 * CLI starts itself goes straight to `runningPromptId`, never listed (every
 * capture, fixtures 15–23). And the CLI runs one prompt at a time, in order:
 * a CLI prompt announced while a turn of ours is still settling — fixture
 * 20's first monitor line, 15 ms before the user's prompt's RPC result — is
 * already the one running, and waits here for that turn to settle.
 */
export class GrokPromptQueue {
  private readonly listed = new Set<string>();
  private readonly cli = new Set<string>();
  private readonly pending: CliPrompt[] = [];

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
    this.pending.push(prompt);
    this.pending.splice(0, Math.max(0, this.pending.length - PROMPT_IDS_REMEMBERED));
  }

  /** The next CLI prompt waiting for a turn, taken. */
  takePending(): CliPrompt | undefined {
    return this.pending.shift();
  }

  isPending(promptId: string): boolean {
    return this.pending.some((prompt) => prompt.promptId === promptId);
  }

  /** Forget a pending CLI prompt (it ended, or a cancel ended it). */
  dropPending(promptId: string): boolean {
    const index = this.pending.findIndex((prompt) => prompt.promptId === promptId);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  /**
   * The CLI prompt a `session/cancel` sent now would end: the NEWEST pending
   * one — the CLI already runs it, one prompt at a time (fixtures 05, 23: a
   * cancel ends the running prompt; 21: with none running it ends none).
   */
  newestPending(): CliPrompt | undefined {
    return this.pending.at(-1);
  }

  clearPending(): void {
    this.pending.length = 0;
  }
}
