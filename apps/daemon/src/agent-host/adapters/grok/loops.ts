/**
 * Grok adapter — loops: the scheduler's prompts (`/loop`, `scheduler_create`,
 * reported as `_x.ai/scheduled_task_*`), each a roster row typed `scheduled`
 * and never live work — each fire is a subagent the CLI spawns itself
 * (fixture 29, observation 52). The session's goal is no roster row: it is
 * the thread's goal (`goal.ts`, goals §6.3; fixture 30, observations 53 and
 * 57). Functions over the normaliser's state (`normalizer-state.ts`);
 * `normalize.ts` routes the reports here.
 */

import type { RuntimeEvent, RuntimeEventRaw } from "@orquester/api/agent-chat";

import {
  event,
  evictOldest,
  textArgument,
  type GrokNormalizerDeps,
  type GrokNormalizerState
} from "./normalizer-state.ts";

/**
 * One scheduled prompt — a `/loop`, a `scheduler_create` — by its scheduler
 * task id (fixture 29, observation 52). It runs nothing of its own: each fire
 * is a background subagent the CLI spawns itself, an agent row under its own
 * id, whose end wakes the parent. So its row is typed `scheduled`, which the
 * liveness registry never counts (`INERT_TASK_TYPES`): a week-long loop
 * must not hold a deploy's drain between its fires. It ends when the CLI
 * deletes it, and with the process it lives in.
 */
export interface LoopTrack {
  readonly taskId: string;
  /** The CLI's `human_schedule`: `"every 1 minute"`. */
  schedule: string;
  /** The prompt's first line. */
  prompt: string;
  fires: number;
  /** Its run: the CLI re-creating an ended loop is a new run, a new launch id. */
  run: number;
  /**
   * The launch that numbers its runs ({@link GrokNormalizerDeps.launchNonce}):
   * every launch counts from 1, so a run's launch id names the launch too.
   */
  readonly launch: string;
  /** The turn it was created on: every row of the loop rides it, as a shell's do. */
  readonly turnId?: string;
  live: boolean;
}

/** How many loops the normaliser remembers, the live never forgotten. */
const LOOPS_REMEMBERED = 256;

/** A text's first non-empty line, trimmed; `undefined` for none. */
function firstLineOf(text: string | undefined): string | undefined {
  return text?.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
}

function capitalized(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1).replace(/_/g, " ")}`;
}

/**
 * `_x.ai/scheduled_task_created` / `_fired` / `_deleted` — the scheduler's
 * own reports of one scheduled prompt (`/loop`, `scheduler_create`), methods
 * of their own, keyed by its task id (fixture 29, observation 52). Before
 * they were mapped, each was a peer warning: one per fire of a week-long
 * loop. Created: the loop's row starts, typed `scheduled`, titled by its
 * schedule. Fired: the fire notes itself on that row, status-less and in
 * place — the fire itself is the background subagent the CLI spawns right
 * after, an agent row of its own. Deleted: the row ends, `stopped` for a
 * `scheduler_delete` (`reason: "deleted"`), `completed` for one that ran its
 * course (`expired`: loops expire after seven days, read off the docs, not
 * captured). A report naming a loop this process never saw created starts
 * its row first; a loop already ended ends nothing again — a fire after the
 * adapter's own end (a Stop that left the process up; whether a Stop's
 * `session/cancel` deletes a loop is not captured) notes itself on the
 * ended row, and only the CLI re-creating it opens a new run.
 */
export function scheduledTask(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const taskId = textArgument(update, "task_id");
  if (taskId === undefined) {
    return [];
  }
  const kind = update["sessionUpdate"];
  const schedule = textArgument(update, "human_schedule");
  const prompt = firstLineOf(textArgument(update, "prompt"));
  let loop = state.loops.get(taskId);
  if (kind === "scheduled_task_deleted") {
    if (loop === undefined || !loop.live) {
      return [];
    }
    loop.live = false;
    const reason = textArgument(update, "reason");
    return [
      event(
        state,
        "task.completed",
        {
          ...loopLinkage(loop),
          status: reason === "expired" ? "completed" : "stopped",
          summary: reason === undefined ? "Deleted" : capitalized(reason)
        },
        loop.turnId,
        raw
      )
    ];
  }
  const events: RuntimeEvent[] = [];
  if (loop === undefined) {
    loop = {
      taskId,
      schedule: schedule ?? "on a schedule",
      prompt: prompt ?? "",
      fires: 0,
      run: 1,
      launch: state.deps.launchNonce,
      turnId: state.deps.activeTurnId(),
      live: true
    };
    state.loops.set(taskId, loop);
    evictOldest(state.loops, LOOPS_REMEMBERED, (value) => !value.live);
    events.push(event(state, "task.started", loopLinkage(loop), loop.turnId, raw));
  } else if (kind === "scheduled_task_created") {
    // The CLI re-created a loop it knows (`scheduler_create` naming its id):
    // new words on a live one, a new run of an ended one.
    loop.schedule = schedule ?? loop.schedule;
    loop.prompt = prompt ?? loop.prompt;
    if (loop.live) {
      events.push(event(state, "task.updated", loopLinkage(loop), loop.turnId, raw));
    } else {
      loop.live = true;
      loop.run += 1;
      loop.fires = 0;
      events.push(event(state, "task.started", loopLinkage(loop), loop.turnId, raw));
    }
  }
  if (kind === "scheduled_task_fired") {
    loop.fires += 1;
    events.push(
      event(
        state,
        "task.progress",
        {
          ...loopLinkage(loop),
          summary: loop.fires === 1 ? "Fired once" : `Fired ${loop.fires} times`
        },
        loop.turnId,
        raw
      )
    );
  }
  return events;
}

/**
 * Every row of a loop: nobody's work but the thread's, never live work
 * (`INERT_TASK_TYPES`). The roster folds its type to a `loop` row, chipped
 * as one; its title is its cadence, then what it does.
 */
export function loopLinkage(loop: LoopTrack): {
  taskId: string;
  taskType: "scheduled";
  title: string;
  description: string;
  toolUseId: string;
} {
  const cadence = capitalized(loop.schedule);
  return {
    taskId: loop.taskId,
    taskType: "scheduled",
    title: loop.prompt.length > 0 ? `${cadence}: ${loop.prompt}` : cadence,
    description: loop.prompt.length > 0 ? loop.prompt : cadence,
    toolUseId: `loop-run:${loop.taskId}:${loop.launch}:${loop.run}`
  };
}
