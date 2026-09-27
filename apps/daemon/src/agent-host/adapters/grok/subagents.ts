/**
 * Grok adapter — subagents: a roster agent is its `spawn_subagent` call and
 * what the CLI reports of it — `subagent_spawned` (its run's id, which is its
 * child session's), `subagent_progress` (its heartbeat), `subagent_finished`
 * (its end) — and a snapshot entry, a poll or a kill answer naming it; a
 * `resume_from` launch starts the same agent again. Its child session
 * (`ChildSession`) is the agent's own: `normalize.ts` routes that session's
 * frames to its rows, and the run's end closes what it left open. Functions
 * over the normaliser's state (`normalizer-state.ts`).
 */

import type {
  RuntimeEvent,
  RuntimeEventRaw,
  RuntimeTaskStatus,
  RuntimeTaskUsage
} from "@orquester/api/agent-chat";

import type { SessionUpdate, ToolCallStatus } from "./acp/_generated/schema.ts";
import type {
  XaiSubagentFinishedUpdate,
  XaiSubagentProgressUpdate,
  XaiSubagentSpawnedUpdate
} from "./acp/_generated/xai.ts";
import {
  hasEnded,
  isEndedTaskStatus,
  orphanAgentTasks,
  pollLifecycle,
  rememberEndedTask,
  type backgroundFromToolCall,
  type foldBackgroundTasks,
  type TaskEndSource
} from "./background-tasks.ts";
import type { GrokNormalizer } from "./normalize.ts";
import { asRecord, event, evictOldest, textArgument, type GrokNormalizerState } from "./normalizer-state.ts";
import { closeChildSegments } from "./segments.ts";
import { failTool, isTerminalToolStatus } from "./tool-calls.ts";
import { toolContentText } from "./tool-output.ts";

/**
 * One subagent's child session (`subagent_spawned.child_session_id`, which is
 * also its `subagent_id`). Its frames reach this client under its own
 * `sessionId` — the child's thinking, words, tool calls, background tasks,
 * turn ends and hooks (fixture 15) — and they are that agent's own rows,
 * never the parent's state.
 */
export interface ChildSession {
  readonly sessionId: string;
  /**
   * The roster task (agent) the session is: every row it produces is owned by
   * it. A resume is a NEW child session of the SAME task (fixture 17), so a
   * segment's item id names the session as well — ingestion derives a
   * message's id from its item's, and one keyed by the task alone appended the
   * resumed run's words to the first run's settled message, in the log.
   */
  readonly taskId: string;
  /** The open assistant text segment, and the turn it rides. */
  text?: { readonly itemId: string; readonly turnId: string | undefined };
  /** The open reasoning block, and the turn it rides. */
  reasoning?: { readonly itemId: string; readonly turnId: string | undefined };
  nextSegment: number;
}

/** One roster agent `spawn_subagent` launched, keyed by its task id (§7.6). */
export interface SubagentTrack {
  readonly taskId: string;
  /** The call that launched the latest run, named on every row as `toolUseId`. */
  toolUseId: string;
  /** The call that opened the run in progress — whose kind decides how it ends. */
  owner: string;
  title: string;
  description: string;
  role?: string;
  live: boolean;
  /**
   * The run in progress goes on without its call: launched `background`, or
   * a foreground run the CLI moved to the background (its answer was not the
   * completion tag) or whose call its turn cut. Said once, on the row that
   * made it so.
   */
  backgrounded: boolean;
  /** The turn the run started in, for the rows that close it after that turn. */
  turnId?: string;
  /** A `background_tasks` snapshot listed it (see {@link foldBackgroundTasks}). */
  listed: boolean;
  /** Who wrote the latest run's end, while it is not live. */
  endedBy?: TaskEndSource;
  /** The model `subagent_spawned` named, carried on the agent's later rows. */
  model?: string;
  /**
   * Live again on the CLI's word after an end the adapter wrote itself (see
   * {@link reviveSubagent}): the roster keeps that end, so no
   * row of this run names a status that would reopen it.
   */
  revived: boolean;
}

/** One `spawn_subagent` call, keyed by its call id. */
export interface SubagentLaunch {
  readonly taskId: string;
  /** The call's own `description` argument, for joining its `subagent_spawned`. */
  readonly description?: string;
  /** `background: true` — the call answers with the subagent's id at once. */
  readonly background: boolean;
  /** The call started or reopened the run, so its failure is the run's. */
  readonly opensRun: boolean;
  /** Ids the launch's own input named: never taken for its subagent's. */
  readonly inputIds: ReadonlySet<string>;
  /**
   * The call's run went on without it: the call answered (a background launch,
   * or the CLI moved a foreground one to the background) or its turn cut it.
   * From here only the completion tag ends the run through the call — a
   * failure of the call is the call's own.
   */
  detached: boolean;
  settled: boolean;
  /** A `subagent_spawned` has named this launch's child (see {@link subagentSpawned}). */
  joined: boolean;
  /**
   * A Stop cut the call before any `subagent_spawned` named its child, and
   * ended its agent (see {@link cutUnspawnedLaunch}) — the one ended launch a
   * late `subagent_spawned` still joins: unsupervised, the CLI spawns at once,
   * and its report can trail the cut by milliseconds. Joined, the child's
   * frames and its end are that agent's, never a second agent's.
   */
  cutBeforeSpawn: boolean;
  /**
   * The call's answer named its child's id ({@link learnSubagentIds}) before
   * any `subagent_spawned` joined it: that child is known by id, so a spawn
   * naming another id never takes this launch by its description
   * ({@link unjoinedLaunch}). Two launches of one description run in
   * parallel in real goal sessions, answered before their spawns (1.0.3,
   * fixtures README observation 58).
   */
  reported: boolean;
}

/**
 * The tool that launches a subagent, in the CLI's own tool namespace — the
 * CLI's embedded docs and its Claude-compat tool table (`Agent` →
 * `spawn_subagent`). Captured (fixtures 15–23): its first frame is titled
 * `spawn_subagent` with the model's arguments as `rawInput` (`description`,
 * `prompt`, `subagent_type`, `background`, `resume_from`) and names itself in
 * `_meta["x.ai/tool"]`; the rewrite that follows is `{variant: "Task", …,
 * run_in_background, task_id: null}`.
 */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

export const GROK_TOOL_NAMESPACE = "grok_build";

/**
 * The `rawOutput` tag of a foreground spawn that ran its child to the end:
 * `{type: "SubagentCompleted", output, subagent_id, subagent_type,
 * tool_calls, turns, duration_ms, worktree_path, resume_from_hint}` (fixtures
 * 15, 17), a millisecond after `subagent_finished`. Any other answer — a
 * background launch's `Text`, or a foreground run's the CLI moved to the
 * background (fixture 22) — means the run goes on.
 */
const SUBAGENT_COMPLETED_OUTPUT = "SubagentCompleted";

/**
 * A subagent's result as the CLI hands it to the PARENT model: its answer,
 * then `<subagent_meta>…</subagent_meta>` and `<subagent_result>…</subagent_result>`
 * blocks naming its id, counts and how to resume it (fixtures 15–17: the
 * `SubagentCompleted` call's content, a poll's `output`). The blocks are for
 * the model; the roster's result is the answer alone. `undefined` when
 * nothing is left.
 */
export function subagentAnswerText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const answer = text
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, "")
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/g, "")
    .trim();
  return answer.length > 0 ? answer : undefined;
}

/** A task's usage, off the counters `subagent_progress` / `subagent_finished` carry. */
function subagentUsage(
  tokens: unknown,
  toolUses: unknown,
  durationMs: unknown
): RuntimeTaskUsage | undefined {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const totalTokens = count(tokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const uses = count(toolUses);
  const duration = count(durationMs);
  return {
    totalTokens,
    ...(uses === undefined ? {} : { toolUses: uses }),
    ...(duration === undefined ? {} : { durationMs: duration })
  };
}

/**
 * A `subagent_finished` status as a run's end. Captured: `completed` (with
 * `output`) and `cancelled` (with `error`, no `output`) — every way a run
 * ends short: a kill, a Stop's `session/cancel` and a cut foreground call
 * ("Subagent was cancelled", fixtures 18, 21, 23), a tool of the child's the
 * user declined ("Subagent turn was cancelled: user rejected permission — …",
 * fixture 26) and the runtime's own turn cap ("max turns reached (limit: 1)",
 * fixture 28). The CLI never said `failed` in any capture; `cancelled` is
 * read as `stopped`, and its `error` is the row's reason
 * ({@link subagentFinished}). The rest follows the poll
 * vocabulary; a status nobody knows ends the run failed when it carries an
 * `error`, else completed.
 */
function finishedStatus(status: unknown, error: unknown): "completed" | "failed" | "stopped" {
  switch (typeof status === "string" ? status.trim().toLowerCase() : undefined) {
    case "interrupted":
    case "aborted":
      return "stopped";
    case "timed_out":
    case "timeout":
      return "failed";
    default:
      break;
  }
  const lifecycle = pollLifecycle(status, undefined);
  if (lifecycle !== undefined && lifecycle !== "running") {
    return lifecycle;
  }
  return typeof error === "string" && error.trim().length > 0 ? "failed" : "completed";
}

/**
 * How many launches, agents and subagent ids the normaliser remembers for
 * `resume_from`, oldest forgotten first (a live agent never is). A resume of a
 * forgotten id starts a row of its own — the same as after a host restart.
 */
export const SUBAGENTS_REMEMBERED = 512;

/**
 * How long a Grok agent counts as live work after the latest row naming it
 * (`livenessTtlMs` on every one of its rows): an hour. A run reports its end
 * (`subagent_finished`) and, while it runs, a heartbeat about every ten
 * seconds (`subagent_progress`, fixtures 16 and 19) that re-arms the hour — so
 * the bound is for a run whose reports stop without an end, which would
 * otherwise hold "working" — and every code-only deploy's drain — for as long
 * as its chat stays open. Liveness only: the roster keeps the row.
 */
export const GROK_AGENT_LIVENESS_TTL_MS = 60 * 60_000;

/** At most this many ids are taken from one launch's result. */
const IDS_PER_LAUNCH = 16;

/** Grok's subagent ids are UUIDv7 ("Subagent id must be a UUIDv7", the CLI's own message). */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function uuidsIn(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase());
}

/**
 * A `spawn_subagent` call → a roster agent (§7.6). Captured (fixtures
 * 15–23): the call, then `subagent_spawned` naming the run's id and child
 * session ({@link subagentSpawned}), the child's own frames under that
 * session ({@link GrokNormalizer.childSessionUpdate}), `subagent_progress`
 * heartbeats ({@link subagentProgress}) and `subagent_finished` — the run's
 * end, every way it ends ({@link subagentFinished}).
 *
 * - The call's first frame STARTS the agent: `task.started`, agent-kind
 *   (`taskType: "subagent"`), stamped with its own id like every Grok task,
 *   launched by the call (`toolUseId`), so the GUI hides the launch row
 *   behind the agent's the way it hides a Claude `Agent` call.
 * - `subagent_finished` ends it, once. The call's own answer ends it only
 *   when that end never came: a foreground call answered with the completion
 *   tag (`SubagentCompleted`) ends the agent with the CLI's `output` as its
 *   result; a call that fails before its run goes on fails it.
 * - Any other answer means the run goes on without its call: a
 *   `background: true` launch answers at once with the subagent's id (a
 *   `Text` answer, fixture 16), and the CLI moves a foreground run past its
 *   await budget to the background (fixture 22: "Subagent took longer than
 *   the foreground budget and was moved to the background…"). A foreground
 *   call its turn cut is NOT one of these: the CLI cancels the child with
 *   the turn (fixture 23; {@link GrokNormalizer.endTurn}). Such a run ends
 *   by `subagent_finished`, a poll or kill answer
 *   ({@link backgroundFromToolCall}, T3's reader), Stop, the session's stop
 *   or the process's exit ({@link GrokNormalizer.stopBackgroundTasks}); its
 *   liveness lapses an hour after the latest row naming it
 *   ({@link GROK_AGENT_LIVENESS_TTL_MS}).
 * - `resume_from` re-launches a completed subagent. The relaunch contract
 *   (AGENTS.md, "Agent rows must survive resumes and retention", rule 1):
 *   the SAME task starts again under the NEW call, before any row of the
 *   run, so the roster reopens it; the task is found by the subagent id the
 *   source launch reported ({@link learnSubagentIds}) — the resume spawns a
 *   NEW subagent id, joined to the same task by `resumed_from` (fixture
 *   17); an id no launch reported (a host restart since) names a task of its
 *   own.
 */
export function subagentFromToolCall(
  state: GrokNormalizerState,
  toolCallId: string,
  rawInput: unknown,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  status: ToolCallStatus | undefined,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let launch = state.subagentLaunches.get(toolCallId);
  if (launch === undefined) {
    launch = launchSubagent(state, toolCallId, asRecord(rawInput), raw, events);
  }
  if (isTerminalToolStatus(status) && !launch.settled) {
    launch.settled = true;
    events.push(...settleSubagentLaunch(state, launch, status === "failed", update, raw));
  }
  return events;
}

function launchSubagent(
  state: GrokNormalizerState,
  toolCallId: string,
  input: Record<string, unknown> | undefined,
  raw: RuntimeEventRaw,
  events: RuntimeEvent[]
): SubagentLaunch {
  const resumeFrom = textArgument(input, "resume_from");
  const taskId =
    resumeFrom === undefined
      ? toolCallId
      : (state.subagentIds.get(resumeFrom.toLowerCase()) ?? resumeFrom);
  const description = textArgument(input, "description");
  const role = textArgument(input, "subagent_type");
  // `background` is the tool's own argument (its documented parameter; the
  // first frame carries the model's arguments as it wrote them).
  const background = input?.["background"] === true;
  // What THIS launch asked the agent to do, verbatim — its `prompt`
  // argument, a resume's own on a resume (fixtures 15, 17) — for the top of
  // the agent's drill-in (§7.6). It rides the start of the run it opens
  // alone; the child's `user_message_chunk` repeats it after the start. A
  // launch that opens no run — a `resume_from` of an agent still live, which
  // the CLI refuses ("must be completed") — carries none: its words would
  // head the running run with a prompt its agent never received.
  const rawPrompt = input?.["prompt"];
  const prompt =
    typeof rawPrompt === "string" && rawPrompt.trim().length > 0 ? rawPrompt : undefined;
  const existing = state.subagents.get(taskId);
  const opensRun = existing?.live !== true;
  const title = description ?? existing?.title ?? role ?? "Subagent";
  const track: SubagentTrack = existing ?? {
    taskId,
    toolUseId: toolCallId,
    owner: toolCallId,
    title,
    description: title,
    live: false,
    backgrounded: false,
    listed: false,
    revived: false
  };
  track.toolUseId = toolCallId;
  track.title = title;
  track.description = description ?? track.description;
  if (role !== undefined) {
    track.role = role;
  }
  // Any launch naming the agent — a resume of a live one included — starts
  // what a snapshot must list anew: a listing of the run before it, dropped
  // from the next snapshot, is no end of this one. Its start names a new
  // call, which reopens the roster's row: the run is no longer one the
  // roster holds ended.
  track.listed = false;
  track.revived = false;
  if (opensRun) {
    track.owner = toolCallId;
    track.live = true;
    track.backgrounded = background;
    track.turnId = state.deps.activeTurnId();
    track.endedBy = undefined;
  }
  state.subagents.delete(taskId);
  state.subagents.set(taskId, track);
  evictOldest(state.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);

  const launch: SubagentLaunch = {
    taskId,
    ...(description === undefined ? {} : { description }),
    background,
    opensRun,
    inputIds: new Set(uuidsIn(input)),
    detached: false,
    settled: false,
    joined: false,
    cutBeforeSpawn: false,
    reported: false
  };
  state.subagentLaunches.set(toolCallId, launch);
  evictOldest(state.subagentLaunches, SUBAGENTS_REMEMBERED);
  state.lastSubagentTurnId = state.deps.activeTurnId();

  events.push(
    event(
      state,
      "task.started",
      {
        ...subagentLinkage(track),
        description: track.description,
        isBackgrounded: background,
        ...(prompt === undefined || !opensRun ? {} : { prompt })
      },
      undefined,
      raw
    )
  );
  return launch;
}

/**
 * The launch's call reached its end. Only the completion tag ends a run
 * through its call; any other answer sends it on in the background. A failed
 * call fails the run it opened — unless the run had already gone on without
 * it (a cut call's failure is the call's own) — and a resume the CLI refused
 * (its source still running) fails the call and never the agent it named. A
 * failed call no `subagent_spawned` joined never had a child: the user
 * declined the spawn's own card (fixture 25, turn 2: "User rejected the
 * execution for tool `spawn_subagent`") or the CLI refused it, so the run it
 * opened ends `stopped`, with the CLI's text — a run cut short, as a run the
 * user declined reads (observation 50) — never a failed agent that never
 * existed. A resume answered with the completion tag proves the earlier run
 * over, whatever this adapter had seen of it.
 */
function settleSubagentLaunch(
  state: GrokNormalizerState,
  launch: SubagentLaunch,
  failed: boolean,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = state.subagents.get(launch.taskId);
  if (track === undefined) {
    return [];
  }
  if (failed) {
    if (!launch.opensRun) {
      track.toolUseId = track.owner;
      return [];
    }
    if (launch.detached || !track.live) {
      return [];
    }
    return closeSubagent(
      state,
      track,
      launch.joined ? "failed" : "stopped",
      "cli",
      toolContentText(update.content),
      raw
    );
  }
  learnSubagentIds(state, launch, update);
  const output = asRecord(update.rawOutput);
  if (output?.["type"] === SUBAGENT_COMPLETED_OUTPUT) {
    // Normally a no-op: `subagent_finished` arrives a millisecond before
    // this answer and has ended the run already (fixtures 15, 17). The
    // CLI's own `output` is the answer; the call's text adds the
    // `<subagent_meta>` / `<subagent_result>` blocks for the parent model.
    const answer =
      subagentAnswerText(typeof output["output"] === "string" ? output["output"] : undefined) ??
      subagentAnswerText(toolContentText(update.content));
    return track.live ? closeSubagent(state, track, "completed", "cli", answer, raw) : [];
  }
  launch.detached = true;
  return track.live ? backgroundSubagent(state, track, raw) : [];
}

/** The summary of an agent a Stop ended before the CLI spawned it ({@link cutUnspawnedLaunch}). */
export const SUBAGENT_NEVER_STARTED = "Stopped before it started.";

/**
 * A cut `spawn_subagent` call (`GrokNormalizer.cutTurnCalls`) whose launch no
 * `subagent_spawned` joined: the run it opened never started. Supervised, the
 * CLI asks before it spawns (fixture 25, observation 49), so a Stop while
 * that card is pending cuts the call with no child in existence — nothing
 * the CLI cancels, no `subagent_finished` to come — and the agent, started at
 * the call's first frame, read running on the roster and held a deploy's
 * drain for its hour. It ends here, `stopped`, by the adapter's word. A
 * launch a spawn joined keeps waiting for the CLI's end (fixture 23:
 * `subagent_finished {cancelled}` 42 ms after the cancel). One narrow window
 * is known and kept: unsupervised, a `subagent_spawned` trailing the Stop by
 * the 7–20 ms of observation 37 means the child did start — its frames join
 * this ended agent (`cutBeforeSpawn`), whose row keeps "Stopped before it
 * started.", and the CLI's `cancelled` end then adds no row.
 */
export function cutUnspawnedLaunch(state: GrokNormalizerState, toolCallId: string): RuntimeEvent[] {
  const launch = state.subagentLaunches.get(toolCallId);
  if (launch === undefined || launch.joined || launch.settled || launch.detached || !launch.opensRun) {
    return [];
  }
  const track = state.subagents.get(launch.taskId);
  if (track === undefined || !track.live || track.owner !== toolCallId) {
    return [];
  }
  launch.settled = true;
  launch.cutBeforeSpawn = true;
  return closeSubagent(state, track, "stopped", "adapter", SUBAGENT_NEVER_STARTED);
}

/**
 * A foreground run that goes on without its call, said once:
 * `task.updated {isBackgrounded: true}` — the roster keeps a live
 * background row in view — naming the turn the run started in.
 */
function backgroundSubagent(state: GrokNormalizerState, track: SubagentTrack, raw?: RuntimeEventRaw): RuntimeEvent[] {
  if (track.backgrounded) {
    return [];
  }
  track.backgrounded = true;
  return [
    event(
      state,
      "task.updated",
      { ...subagentLinkage(track), isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_spawned`, in the parent's session, before any frame of the
 * child (fixtures 15–23). It names the run's `subagent_id` — which IS its
 * child session's id — and, for a resume, the source it continues: a
 * `resume_from` launch spawns a NEW id naming its source in `resumed_from`
 * (fixture 17). Joined to its launch:
 * - an id a launch already reported is that launch's agent (a background
 *   launch answers with its id a few milliseconds BEFORE this frame,
 *   fixture 16);
 * - a resume is the task its source is;
 * - else the oldest `spawn_subagent` launch no spawn has named yet — one
 *   whose description matches first, since calls of one response spawn in
 *   order.
 * A spawn no launch explains — the CLI's own (a `/loop` fire runs "in a
 * detached background subagent", its docs say; not captured) — is an agent
 * of its own, under its subagent id. From here the child session's frames
 * are that agent's own rows ({@link GrokNormalizer.childSessionUpdate}).
 */
export function subagentSpawned(
  state: GrokNormalizerState,
  update: XaiSubagentSpawnedUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const record = update as unknown as Record<string, unknown>;
  const subagentId = textArgument(record, "subagent_id");
  if (subagentId === undefined) {
    return [
      event(state, "runtime.warning", { message: "grok: subagent_spawned without a subagent_id" }, undefined, raw)
    ];
  }
  const description = textArgument(record, "description");
  const resumedFrom = textArgument(record, "resumed_from");
  const events: RuntimeEvent[] = [];
  let taskId = state.subagentIds.get(subagentId.toLowerCase());
  let resumed = false;
  if (taskId === undefined && resumedFrom !== undefined) {
    taskId = state.subagentIds.get(resumedFrom.toLowerCase());
    resumed = taskId !== undefined;
  }
  taskId ??= unjoinedLaunch(state, description)?.taskId;
  if (taskId === undefined) {
    taskId = subagentId;
    events.push(...startUnlaunchedSubagent(state, subagentId, record, raw));
  }
  const track = state.subagents.get(taskId);
  if (resumed && track !== undefined && !track.live) {
    events.push(...relaunchResumedSubagent(state, track, subagentId, raw));
  }
  const launch = track === undefined ? undefined : state.subagentLaunches.get(track.toolUseId);
  if (launch !== undefined) {
    launch.joined = true;
  }
  const model = textArgument(record, "model");
  if (track !== undefined && model !== undefined) {
    track.model = model;
  }
  rememberSubagentId(state, subagentId, taskId);
  const childSessionId = textArgument(record, "child_session_id") ?? subagentId;
  rememberSubagentId(state, childSessionId, taskId);
  state.children.delete(childSessionId.toLowerCase());
  state.children.set(childSessionId.toLowerCase(), { sessionId: childSessionId, taskId, nextSegment: 0 });
  evictOldest(state.children, SUBAGENTS_REMEMBERED, (child) => state.subagents.get(child.taskId)?.live !== true);
  return events;
}

/**
 * A resume the CLI ran by itself — `subagent_spawned {resumed_from}` with no
 * `spawn_subagent` call of this session's behind it, as a goal's engine
 * resumes a skeptic (1.0.3 goal sessions, fixtures README observation 58) —
 * of an agent whose run had ended: a new run of the SAME task under a new
 * launch id, the resume's own subagent id (the relaunch contract, observation
 * 43), so the roster reopens its row and the run's rows and end are recorded.
 * Left ended, the resumed run's frames joined an ended agent and its answer
 * was read as a late report of the run before it — dropped. A model's resume
 * was already relaunched by its call's first frame, and finds the run live.
 */
function relaunchResumedSubagent(
  state: GrokNormalizerState,
  track: SubagentTrack,
  subagentId: string,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  track.toolUseId = subagentId;
  track.owner = subagentId;
  track.live = true;
  track.backgrounded = true;
  track.turnId = state.deps.activeTurnId();
  track.endedBy = undefined;
  track.listed = false;
  track.revived = false;
  state.subagents.delete(track.taskId);
  state.subagents.set(track.taskId, track);
  if (track.turnId !== undefined) {
    state.lastSubagentTurnId = track.turnId;
  }
  return [
    event(
      state,
      "task.started",
      { ...subagentLinkage(track), description: track.description, isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/**
 * The oldest live launch no `subagent_spawned` has named yet — a matching
 * description first — or one a Stop cut before it could ({@link
 * SubagentLaunch.cutBeforeSpawn}).
 */
function unjoinedLaunch(state: GrokNormalizerState, description: string | undefined): SubagentLaunch | undefined {
  let oldest: SubagentLaunch | undefined;
  for (const launch of state.subagentLaunches.values()) {
    if (
      launch.joined ||
      launch.reported ||
      (state.subagents.get(launch.taskId)?.live !== true && !launch.cutBeforeSpawn)
    ) {
      continue;
    }
    if (description !== undefined && launch.description === description) {
      return launch;
    }
    oldest ??= launch;
  }
  return oldest;
}

/**
 * An agent the CLI spawned with no `spawn_subagent` call of this session's:
 * started under its own id, which is also its launch id (the relaunch
 * contract's first start), backgrounded — nothing waits on it.
 */
function startUnlaunchedSubagent(
  state: GrokNormalizerState,
  subagentId: string,
  record: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  // 1.0.3's goal sessions name an explore agent's `role` (fixtures README
  // observation 58); the 1.0.34 captures carry `subagent_type` alone.
  const role = textArgument(record, "role") ?? textArgument(record, "subagent_type");
  const title = textArgument(record, "description") ?? role ?? "Subagent";
  const model = textArgument(record, "model");
  const track: SubagentTrack = {
    taskId: subagentId,
    toolUseId: subagentId,
    owner: subagentId,
    title,
    description: title,
    ...(role === undefined ? {} : { role }),
    ...(model === undefined ? {} : { model }),
    live: true,
    backgrounded: true,
    turnId: state.deps.activeTurnId(),
    listed: false,
    revived: false
  };
  state.subagents.set(subagentId, track);
  evictOldest(state.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);
  // Spawned while a turn runs — a goal's planner inside the `/goal` prompt —
  // it is that turn's subagent (`TurnTokenUsage.hasSubagents`); a loop's fire
  // between turns counts for none.
  if (track.turnId !== undefined) {
    state.lastSubagentTurnId = track.turnId;
  }
  return [
    event(
      state,
      "task.started",
      { ...subagentLinkage(track), description: title, isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_progress`: the child's heartbeat — about every ten seconds while
 * it runs, and after each of its tool calls (fixtures 16, 19). One
 * status-less `task.progress` carrying its counters: a heartbeat never names
 * a status, so a late one cannot reopen an ended run, and it re-arms the
 * agent's hour ({@link GROK_AGENT_LIVENESS_TTL_MS}). Progress rows have a
 * stable per-task id and replace the last, so the heartbeat costs one row
 * per agent, not one per tick. A heartbeat of a run the adapter closed
 * itself is the CLI saying it still runs ({@link subagentReport}).
 */
export function subagentProgress(
  state: GrokNormalizerState,
  update: XaiSubagentProgressUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = subagentNamed(state, String(update.subagent_id ?? ""));
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    return subagentReport(state, track, true, raw);
  }
  const usage = subagentUsage(update.tokens_used, update.tool_call_count, update.duration_ms);
  return [
    event(
      state,
      "task.progress",
      {
        ...subagentLinkage(track),
        description: track.title,
        ...(usage === undefined ? {} : { usage })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_finished`: the run's end, foreground or background, whoever
 * ended it — its own answer, a kill, a Stop's `session/cancel`, a cut call
 * (fixtures 15–23). The CLI's end, once: `completed` with its `output` as the
 * agent's result, `cancelled` as `stopped`, a failure with its `error`, and
 * the run's counters as its usage. A run already ended gets nothing more —
 * the foreground call's `SubagentCompleted` answer a millisecond later, a
 * kill answer before it (fixture 18) — and one the adapter closed itself
 * (Stop) takes it as the CLI's final word, with no row ({@link subagentReport}).
 * `will_wake: true` announces the parent's wake, which is the session's.
 */
export function subagentFinished(
  state: GrokNormalizerState,
  update: XaiSubagentFinishedUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = subagentNamed(state, String(update.subagent_id ?? ""));
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    return subagentReport(state, track, false, raw);
  }
  const owner = state.subagentLaunches.get(track.owner);
  if (owner !== undefined) {
    owner.settled = true;
  }
  const status = finishedStatus(update.status, update.error);
  const answer = subagentAnswerText(typeof update.output === "string" ? update.output : undefined);
  const error = typeof update.error === "string" && update.error.trim().length > 0 ? update.error.trim() : undefined;
  // A run that ended short says why in `error` — a declined tool, a turn
  // cap, a kill — and a `stopped` row without it read as a bare "Stopped"
  // (fixtures 26, 28): the reason is its summary, as a failure's is.
  const summary = status === "completed" ? answer : (error ?? answer);
  const usage = subagentUsage(update.tokens_used, update.tool_calls, update.duration_ms);
  return closeSubagent(state, track, status, "cli", summary, raw, usage);
}

/**
 * Remember the subagent id(s) a launch reported, for a later `resume_from`.
 * Read shape-free — the UUIDs in what the call returned: the CLI's subagent
 * ids are UUIDv7, and the result is where the parent model learns the id it
 * later passes to `resume_from` (captured: a background launch's `Text`
 * answer names `subagent_id: <id>`, fixture 16; a foreground result's
 * `SubagentCompleted` output its `subagent_id` and `resume_from_hint`,
 * fixture 15). `subagent_spawned` names it too ({@link subagentSpawned});
 * whichever comes first is kept.
 *
 * The CLI's own `rawOutput` is read first, and the text only when it names
 * none: the text of a foreground result is the subagent's summary, model
 * prose that may quote any id. Never taken: an id the launch's own input
 * named (a prompt quoting another agent's), the session's own id, a live
 * shell's (whose snapshot rows must stay the shell's), and an id an earlier
 * launch reported first. Nothing is taken for a launch a spawn already
 * joined: its child's id was remembered by that join, and a description
 * join can be wrong — two launches of one description in parallel — so an
 * id its answer names may be the OTHER launch's child, and taken here it made
 * one agent of both children (the other launch's agent never started, its
 * child's end was dropped).
 */
function learnSubagentIds(
  state: GrokNormalizerState,
  launch: SubagentLaunch,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>
): void {
  if (launch.joined) {
    return;
  }
  const usable = (id: string): boolean =>
    !launch.inputIds.has(id) &&
    id !== state.sessionId &&
    !state.tasks.has(id) &&
    !hasEnded(state, id) &&
    !state.subagentIds.has(id);
  const structured = uuidsIn(update.rawOutput).filter(usable);
  const ids = structured.length > 0 ? structured : uuidsIn(update.content).filter(usable);
  for (const id of ids.slice(0, IDS_PER_LAUNCH)) {
    rememberSubagentId(state, id, launch.taskId);
    launch.reported = true;
  }
}

function rememberSubagentId(state: GrokNormalizerState, id: string, taskId: string): void {
  const key = id.toLowerCase();
  if (state.subagentIds.has(key)) {
    return;
  }
  state.subagentIds.set(key, taskId);
  evictOldest(state.subagentIds, SUBAGENTS_REMEMBERED);
}

/**
 * A subagent run's end was written: who wrote it, on the track, and the ids
 * that named it, so no frame naming one — once its launch is forgotten —
 * becomes a shell. A resumed run is found through its launch first, so this
 * never hides it. The CLI's word is never replaced by the adapter's.
 */
function rememberEndedSubagent(state: GrokNormalizerState, track: SubagentTrack, by: TaskEndSource): void {
  track.endedBy = track.endedBy === "cli" ? "cli" : by;
  rememberEndedTask(state, track.taskId, track.endedBy);
  for (const [id, taskId] of state.subagentIds) {
    if (taskId === track.taskId) {
      rememberEndedTask(state, id, track.endedBy);
    }
  }
}

/**
 * A CLI report naming a subagent run that is not live — `shellReport`'s rule
 * (`background-tasks.ts`): after an end the adapter wrote itself, a report
 * that it still runs counts it live again ({@link reviveSubagent}) and a
 * report of its end is the CLI's, with no row; after the CLI's own end,
 * nothing.
 */
export function subagentReport(
  state: GrokNormalizerState,
  track: SubagentTrack,
  running: boolean,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  if (track.endedBy !== "adapter") {
    return [];
  }
  if (!running) {
    rememberEndedSubagent(state, track, "cli");
    return [];
  }
  return reviveSubagent(state, track, raw);
}

/**
 * A subagent run the adapter closed itself that the CLI reports still
 * running — a heartbeat, a poll, a listing: live again, under its own start
 * row re-emitted, naming its own launch — which the roster reads as a late
 * delivery (it keeps the adapter's end) and the liveness registry as live
 * work for the agent's hour, re-armed by further reports. Captured, a Stop's
 * `session/cancel` cancels a background child (fixture 21:
 * `subagent_finished {status: "cancelled"}` 50 ms later), so after a Stop
 * this is the rule for what the CLI did not cancel.
 */
function reviveSubagent(state: GrokNormalizerState, track: SubagentTrack, raw: RuntimeEventRaw): RuntimeEvent[] {
  track.live = true;
  track.revived = true;
  track.endedBy = undefined;
  track.listed = false;
  return [
    event(
      state,
      "task.started",
      { ...subagentLinkage(track), description: track.description, isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/** The task a background-task frame's ids name, when they are a subagent's. */
export function subagentOfBackgroundTask(
  state: GrokNormalizerState,
  taskId: string,
  toolCallId: string | undefined
): string | undefined {
  const launched =
    toolCallId === undefined ? undefined : state.subagentLaunches.get(toolCallId)?.taskId;
  if (launched !== undefined) {
    rememberSubagentId(state, taskId, launched);
    return launched;
  }
  return state.subagentIds.get(taskId.toLowerCase());
}

/** What every row naming the agent carries — its liveness TTL included. */
export function subagentLinkage(track: SubagentTrack): {
  taskId: string;
  taskType: string;
  agentId: string;
  title: string;
  role?: string;
  model?: string;
  toolUseId: string;
  livenessTtlMs: number;
} {
  return {
    taskId: track.taskId,
    taskType: "subagent",
    agentId: track.taskId,
    title: track.title,
    ...(track.role === undefined ? {} : { role: track.role }),
    ...(track.model === undefined ? {} : { model: track.model }),
    toolUseId: track.toolUseId,
    livenessTtlMs: GROK_AGENT_LIVENESS_TTL_MS
  };
}

/**
 * `task.completed` for a live agent, and out of the live set — after what
 * its child session left open: its calls first, then its words and
 * thinking, then the task (calls before tasks, as every adapter's teardown
 * orders them). A run's end is its child session's end.
 */
export function closeSubagent(
  state: GrokNormalizerState,
  track: SubagentTrack,
  status: "completed" | "failed" | "stopped",
  by: TaskEndSource,
  summary?: string,
  raw?: RuntimeEventRaw,
  usage?: RuntimeTaskUsage
): RuntimeEvent[] {
  track.live = false;
  track.revived = false;
  rememberEndedSubagent(state, track, by);
  const events = closeAgentWork(state, track.taskId, "The subagent ended.");
  events.push(...orphanAgentTasks(state, track.taskId));
  // The rows that close a run after its turn name the turn it ran in, as a
  // shell's closers do; a foreground end within its own turn is that turn.
  events.push(
    event(
      state,
      "task.completed",
      {
        ...subagentLinkage(track),
        status,
        ...(summary === undefined ? {} : { summary }),
        ...(usage === undefined ? {} : { usage })
      },
      track.turnId,
      raw
    )
  );
  return events;
}

/**
 * What an agent's child session left open when its run ended: its calls,
 * failed with `reason` — each on its own turn, under its owner — and then
 * its open words and thinking.
 */
function closeAgentWork(state: GrokNormalizerState, taskId: string, reason: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [toolCallId, track] of [...state.tools.entries()]) {
    if (track.owned?.agentId === taskId) {
      events.push(...failTool(state, toolCallId, track, reason));
    }
  }
  for (const child of state.children.values()) {
    if (child.taskId === taskId) {
      events.push(...closeChildSegments(state, child));
    }
  }
  return events;
}

/** A snapshot entry of a subagent's: its terminal status ends the agent. */
export function subagentFromSnapshot(
  state: GrokNormalizerState,
  taskId: string,
  status: RuntimeTaskStatus,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = state.subagents.get(taskId);
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    if (status === "idle") {
      return [];
    }
    const events = subagentReport(state, track, !isEndedTaskStatus(status), raw);
    if (track.live) {
      track.listed = true;
    }
    return events;
  }
  track.listed = true;
  switch (status) {
    case "completed":
      return closeSubagent(state, track, "completed", "cli", undefined, raw);
    case "failed":
      return closeSubagent(state, track, "failed", "cli", undefined, raw);
    case "cancelled":
    case "interrupted":
      return closeSubagent(state, track, "stopped", "cli", undefined, raw);
    default:
      return [];
  }
}

/** The agent an answer's id names, through the ids its launches reported. */
export function subagentNamed(state: GrokNormalizerState, id: string): SubagentTrack | undefined {
  const taskId = state.subagentIds.get(id.toLowerCase());
  return taskId === undefined ? undefined : state.subagents.get(taskId);
}
