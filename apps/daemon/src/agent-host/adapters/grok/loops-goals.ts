/**
 * Grok adapter — loops and goals: the scheduler's prompts (`/loop`,
 * `scheduler_create`, reported as `_x.ai/scheduled_task_*`) and the session's
 * autonomous goal (`goal_updated`), each a roster row typed `scheduled` /
 * `goal` and never live work — each fire and each planner is a subagent the
 * CLI spawns itself (fixtures 29–30, observations 52–53). Functions over the
 * normaliser's state (`normalizer-state.ts`); `normalize.ts` routes the
 * reports here.
 */

import type { RuntimeEvent, RuntimeEventRaw } from "@orquester/api/agent-chat";

import type { XaiGoalUpdatedUpdate } from "./acp/_generated/xai.ts";
import type { TaskEndSource } from "./background-tasks.ts";
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

/**
 * The session's autonomous goal (`/goal`, fixture 30, observation 53), one at
 * a time. Its work is the turns, wakes and subagents it drives, each live on
 * its own rows; its row — typed `goal`, never live work either — is where its
 * phase, its token budget and how it ended show. A goal that runs again after
 * an end (`/goal resume`) is a relaunch: a new launch id (`run`), which the
 * roster reads as a new run of the same row.
 */
export interface GoalTrack {
  readonly goalId: string;
  readonly taskId: string;
  objective: string;
  run: number;
  /** The launch that numbers its runs, as a loop's ({@link LoopTrack.launch}). */
  readonly launch: string;
  live: boolean;
  /**
   * Who wrote the latest run's end, while it is not live: the CLI (the goal
   * left `active`) or the adapter (the session's teardown, a Stop). Only a
   * goal the CLI ended is resumed by its next `active` report.
   */
  endedBy?: TaskEndSource;
  turnId?: string;
  /** What the latest progress row said, bar the token count: a note is written on a change. */
  noted?: string;
  /**
   * The latest `tokens_used` its OWN updates reported: a goal a new one
   * replaces ends with it — the update that replaces it counts the new goal.
   */
  tokensUsed?: number;
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

/** A non-negative whole count, or `undefined`. */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * What a goal's progress row says, and the key a new note is written on: the
 * phase (planning first), its deliverables and rounds, its last event — never
 * the token count alone, which ticks every few seconds (fixture 30).
 */
function goalNote(update: XaiGoalUpdatedUpdate): { key: string; summary: string } {
  const planning = update.planning === true;
  const phase = typeof update.phase === "string" && update.phase.length > 0 ? update.phase : "active";
  const done = countOf(update.completed_deliverables);
  const total = countOf(update.total_deliverables);
  const used = countOf(update.tokens_used) ?? 0;
  const budget = countOf(update.token_budget);
  const parts = [
    planning ? "Planning" : capitalized(phase),
    ...(total !== undefined && total > 0 ? [`${done ?? 0} of ${total} deliverables`] : []),
    budget === undefined ? `${used} tokens` : `${used} of ${budget} tokens`
  ];
  const key = [
    planning,
    phase,
    update.last_event ?? "",
    done ?? "",
    total ?? "",
    countOf(update.total_worker_rounds) ?? "",
    countOf(update.total_verify_rounds) ?? ""
  ].join("\u0000");
  return { key, summary: parts.join(" · ") };
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

/**
 * `goal_updated` (fixture 30, observation 53): the session's autonomous goal,
 * restated whole at every change and every few seconds while its planner or
 * worker runs — eleven warnings in one short run before it was mapped. Its
 * row starts when a goal turns `active`, typed `goal` and titled by its
 * objective; a change of phase, of planning, of its last event or of its
 * deliverables and rounds notes itself on the row (status-less, in place),
 * a tick of the token count alone does not. It ends when the goal leaves
 * `active`: `completed` (its result summary), else `stopped` — out of token
 * budget (`budget_limited`, captured), `paused`, `cleared` (every id and text
 * emptied, captured) — or `failed`. A goal active again after the CLI's own
 * end (`/goal resume`) is a new run of the same row; after the adapter's
 * (a Stop), its progress notes itself on the ended row. A new goal ends the
 * old one.
 */
export function goalUpdated(
  state: GrokNormalizerState,
  update: XaiGoalUpdatedUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const goalId = typeof update.goal_id === "string" ? update.goal_id.trim() : "";
  const status = typeof update.status === "string" ? update.status.trim() : "";
  let goal = state.goal;
  if (status !== "active") {
    if (goal === undefined || (goalId.length > 0 && goal.goalId !== goalId)) {
      return [];
    }
    if (!goal.live) {
      // The CLI's end of a goal the adapter closed itself: no second row,
      // but its own word from now on — its next `active` is a resume.
      goal.endedBy = "cli";
      return [];
    }
    return [endGoal(state, goal, update, raw)];
  }
  if (goalId.length === 0) {
    return [];
  }
  const events: RuntimeEvent[] = [];
  const objective = typeof update.objective === "string" && update.objective.trim().length > 0
    ? update.objective.trim()
    : "Goal";
  const note = goalNote(update);
  if (goal === undefined || goal.goalId !== goalId) {
    if (goal?.live === true) {
      events.push(endGoal(state, goal, "replaced", raw));
    }
    goal = {
      goalId,
      taskId: `goal:${goalId}`,
      objective,
      run: 1,
      launch: state.deps.launchNonce,
      live: true,
      turnId: state.deps.activeTurnId()
    };
    state.goal = goal;
  } else if (!goal.live && goal.endedBy === "cli") {
    goal.run += 1;
    goal.live = true;
    goal.endedBy = undefined;
    goal.turnId = state.deps.activeTurnId() ?? goal.turnId;
  } else {
    // Live — or closed by the adapter while the CLI still reports it active
    // (whether a Stop's `session/cancel` stops a goal is not captured): its
    // progress notes itself, on the ended row then, and reopens nothing.
    goal.tokensUsed = countOf(update.tokens_used) ?? goal.tokensUsed;
    if (note.key !== goal.noted) {
      goal.noted = note.key;
      events.push(
        event(
          state,
          "task.progress",
          {
            ...goalLinkage(goal),
            summary: note.summary,
            // Its own count, for its row's metrics: the roster never sums a
            // goal's tokens with its agents' (they are the same tokens).
            ...(goal.tokensUsed === undefined ? {} : { usage: { totalTokens: goal.tokensUsed } })
          },
          goal.turnId,
          raw
        )
      );
    }
    return events;
  }
  goal.objective = objective;
  goal.noted = note.key;
  goal.tokensUsed = countOf(update.tokens_used) ?? goal.tokensUsed;
  events.push(event(state, "task.started", goalLinkage(goal), goal.turnId, raw));
  return events;
}

/**
 * The row that ends a goal's run: by the status its own update left
 * `active` in, or `replaced` by a new goal — whose update counts the NEW
 * goal's tokens, so the old one ends with the count it last reported itself.
 */
function endGoal(
  state: GrokNormalizerState,
  goal: GoalTrack,
  end: XaiGoalUpdatedUpdate | "replaced",
  raw: RuntimeEventRaw
): RuntimeEvent {
  goal.live = false;
  goal.endedBy = "cli";
  const update = end === "replaced" ? undefined : end;
  const used = countOf(update?.tokens_used) ?? goal.tokensUsed;
  const budget = countOf(update?.token_budget);
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const endStatus = end === "replaced" ? "replaced" : end.status;
  const [status, summary] = ((): ["completed" | "failed" | "stopped", string] => {
    switch (endStatus) {
      case "completed":
        return ["completed", text(update?.result_summary) ?? "Goal completed"];
      case "budget_limited":
        return [
          "stopped",
          used !== undefined && budget !== undefined
            ? `Token budget reached: ${used} of ${budget} tokens`
            : "Token budget reached"
        ];
      case "paused":
        return ["stopped", text(update?.pause_message) ?? "Paused"];
      case "cleared":
        return ["stopped", "Cleared"];
      case "replaced":
        return ["stopped", "Replaced by a new goal"];
      case "failed":
        return ["failed", text(update?.pause_message) ?? text(update?.result_summary) ?? "Failed"];
      default:
        return ["stopped", capitalized(String(endStatus || "ended"))];
    }
  })();
  return event(
    state,
    "task.completed",
    {
      ...goalLinkage(goal),
      status,
      summary,
      ...(used === undefined || endStatus === "cleared" ? {} : { usage: { totalTokens: used } })
    },
    goal.turnId,
    raw
  );
}

/** Every row of a goal: never live work (`INERT_TASK_TYPES`); a run is a launch id, the launch's own. */
export function goalLinkage(goal: GoalTrack): {
  taskId: string;
  taskType: "goal";
  title: string;
  description: string;
  toolUseId: string;
} {
  return {
    taskId: goal.taskId,
    taskType: "goal",
    // The roster folds the type to a `goal` row, chipped as one: the title
    // is the objective alone.
    title: goal.objective,
    description: goal.objective,
    toolUseId: `goal-run:${goal.goalId}:${goal.launch}:${goal.run}`
  };
}
