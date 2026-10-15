// Catalog family module `messages` (Conversation: create_session, send_message) — plan Task 8 (unified MCP, Wave 3).
//
// The agent-to-agent conversation (spec §4 rows 10 and 13, §8): `create_session` opens a chat —
// for a chat caller as its `opened` child or its `delegate` task, `agentCreated` (§13 c) — and
// `send_message` talks to one, each with a reply mode: `wait` returns the final reply of the turn
// the message causes, `notify` (chat only) delivers it later as a new message, `none` is fire and
// forget. Reply-requesting messages go through the reply-subscription routes (Task 5's services,
// socket-only): persisted before posting, queued as the target's next turn — never a steer.
//
// The pre-catalog definitions below (`sendMessage`, `implementPlan`, `readTranscript`,
// `messageTools`) stay exported, unserved, for the legacy session toolkit
// (`session-tools/threads`) and their tests until plan Task 14 deletes them; their send path is
// also `send_message`'s `reply: "none"` and the legacy `thread_send {wait}` alias's.
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { AgentConversationsResponse, ApprovalPreviewSection, CreateSessionRequest, SessionSummary } from "@orquester/api";
import { agentChatRoutes, buildPlanImplementationPrompt, GOAL_ACTIVITY_KIND, GOAL_COMMAND_FAILED_ACTIVITY_KIND, GOAL_STATUS_ACTIVITY_KIND, isGoalCommandText, isHiddenGoalChange, MAX_TURN_INPUT_CHARS, parseGoalSupport, parseGoalUpdatedPayload, parseThreadGoal, replyNoticeText, resolveLaunchModel, startedTurns, THREAD_MESSAGE_OVERHEAD_CHARS, threadMessageContext, TURN_NOT_IDLE, UNTRUSTED_NOTICE, type AttachmentRef, type CausedBy, type ComposerContextRecord, type CreateAgentChatSessionFields, type ProviderModel, type ReplySubscriptionResponse, type ReplyWaitResponse, type RuntimeMode, type ThreadGoal, type ThreadItem, type ThreadItemResponse, type ThreadMessageOrigin, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { findAgent, findModel, loadAgents, resolveModelSelection, supportsFrom, validateAccountId, type AgentView } from "../agents.ts";
import { canonicalPath, canonicalProject, resolveProject } from "../addressing.ts";
import { attachmentInputSchema, MAX_ATTACHMENTS, uploadInlineAttachments, type AttachmentInput } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { expectOk, ToolError } from "../errors.ts";
import { readOlderHistory, unavailableHint } from "../history.ts";
import { listSessions, readThread, requireChatSession, sendCommand } from "../reads.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes, toSafeToolError } from "../result.ts";
import { defineTool, MUTATING, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { proposedPlan, transcriptEntries, transcriptRange, type TranscriptResult } from "../transcript.ts";
import { buildViewContext, chatDetail, fitDetail, SETTLED_TURN_STATES, type SessionDetail } from "../views.ts";
import { awaitReplySubscription, turnBaseline, waitForTurn, waitWhileWorking, type TurnBaseline, type TurnOutcome } from "../wait.ts";
import { defineTool as defineCatalogTool, MUTATING as CATALOG_MUTATING, type AnyOrquesterTool, type CallContext, type ScopeContext, type ThreadCaller } from "../catalog/contract.ts";
import { NEW_SESSION, openedThreadRuntimeMode } from "../gate/turn-policy.ts";
import { legacyExternalTools } from "../catalog/legacy.ts";
import { asWaiter } from "../../agent-chat/waits.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT, optionsSchema, runtimeModeSchema } from "./sessions.ts";
import { agentLabel, chatThreadRef, sessionCard, sessionClaim, threadCaller } from "./watch.ts";

const MAX_WAIT_MS = 600_000;
/** read_transcript's ceiling: the budget covers the whole result in UTF-8 bytes (transcript.ts), 5 000 under ok()'s 60 000-byte cap (result.ts). */
const MAX_TRANSCRIPT_CHARS = 55_000;
/**
 * How long a needs-input the snapshot contradicts waits for the summary to move before looking again anyway: just
 * past one host poll (`SUMMARY_POLL_INTERVAL_MS`, 1.5 s, agent-chat/summary.ts). The session's next bus event
 * normally ends the wait first.
 */
const STALE_RECHECK_MS = 2_000;
/**
 * How long send_message waits for the answer to a `/goal` the host runs itself (goals §5.1), counted from when the
 * session is up — the host starts one first when there is none (after stop_session, a host restart, an account
 * switch) — and never past the call's `timeoutMs`: Codex's own deadline for the command (`CODEX_GOAL_COMMAND_MS`,
 * 10 s) with room to spare. A command that changes nothing — a pause of a paused goal — writes no row.
 */
const GOAL_ANSWER_WAIT_MS = 15_000;
/**
 * Once a goal update has landed, how long the rest of the same command gets: replacing a goal writes "cleared", then
 * "set". Also the whole window of a command the goal already makes a no-op (`goalCommandChangesNothing`).
 */
const GOAL_ANSWER_SETTLE_MS = 500;
/** How soon the thread is read again when nothing about the session moved: a status answer moves no summary field. */
const GOAL_ANSWER_RECHECK_MS = 1_000;
/** The most an answer takes, in UTF-8 bytes of its JSON: a status quotes an objective of up to 4 000 characters. */
const GOAL_ANSWER_BYTES = 8_192;
const GOAL_NO_ANSWER_HINT = "No answer came: the command changed nothing (the goal was already so), or the host is still on it. session.chat.goal is the goal as it stands; read_transcript shows an answer that lands later.";
const TRUNCATED_HINT = "Shed to fit maxChars: reasoning, then tool detail, then the oldest rows (coveredTurns says which turns are left). Raise maxChars (max 55000), include less, or use get_turn_diff for one turn's file changes.";
/** get_session sheds subagent rows too when its detail would pass the cap (views.ts), so this promises no full roster. */
const SUBAGENTS_TRIMMED_HINT = "The subagent list was trimmed too; get_session may list more of it.";

/**
 * The hint a read_transcript result carries, or none for a whole one that read every turn of its range: first
 * `unavailable`, the sentence about the turns it could not read whole (history.ts `unavailableHint`), then the shed
 * hint. That one keys on `truncated`, which transcript.ts sets on every result it sheds, a trimmed subagent list alone
 * included; `subagentsTruncated` is present only when the list was trimmed. A shed result stays TRANSCRIPT_HINT_BYTES
 * under `maxChars` for this field, and the `unavailable` sentence's bytes more, so the answer, hint included, keeps
 * within `maxChars`.
 */
function transcriptHint(result: Pick<TranscriptResult, "truncated" | "subagentsTruncated">, unavailable?: string): string | undefined {
  const shed = !result.truncated ? undefined : result.subagentsTruncated ? `${TRUNCATED_HINT} ${SUBAGENTS_TRIMMED_HINT}` : TRUNCATED_HINT;
  return unavailable && shed ? `${unavailable} ${shed}` : unavailable || shed;
}

/** Why a `beforeTurn` past the last turn is refused, naming the range that is not. */
function beforeTurnRefusal(turnCount: number): string {
  if (turnCount === 0) return "This conversation has no started turn yet, so there is no turn to read before: leave beforeTurn out.";
  const valid = turnCount === 1 ? "2" : `between 2 and ${turnCount + 1}`;
  return `beforeTurn must be ${valid}: this conversation has ${turnCount} started turn${turnCount === 1 ? "" : "s"}.`;
}

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
const waitFields = {
  wait: z.boolean().default(true).describe("Block until the turn settles or the agent asks something (default true)."),
  timeoutMs: z.number().int().min(1_000).max(MAX_WAIT_MS).default(120_000).describe("How long to wait, in ms (max 600000). On timeout the turn keeps running.")
};

/**
 * The send preconditions the GUI applies (spec §7.4), and the snapshot they were checked on. An open request holds back
 * every message but a `/goal` the host runs itself (`hostGoal`), as the composer's `pendingRequestBlocksSend` has it:
 * that one starts no turn, so it cannot steer the agent past the request — and pausing or clearing the goal is what a
 * user may want most while an approval waits.
 */
async function readyToSend(api: DaemonApi, summary: SessionSummary, opts: { hostGoal?: boolean } = {}): Promise<ThreadSnapshotPayload> {
  const snap = await readThread(api, summary.id);
  if (opts.hostGoal) return snap;
  const { approvals, userInputs } = snap.pending;
  if (approvals.length || userInputs.length) {
    const open = [
      ...approvals.map((a) => `approval ${a.requestId}`),
      ...userInputs.map((q) => `question ${q.requestId}`)
    ];
    throw new ToolError("PENDING_REQUEST", `Answer the agent first: it is waiting on ${open.join(" and ")} (respond_to_request${userInputs.some((q) => q.dismissible) ? "; a dismissible question may be dismissed" : ""}). get_session shows the details; reply "wait" queues the message behind them instead.`, { approvals: approvals.map((a) => a.requestId), questions: userInputs.map((q) => q.requestId) });
  }
  return snap;
}

type TurnBody = { input: string; attachments?: AttachmentRef[]; interactionMode: "default" | "plan"; context?: readonly ComposerContextRecord[]; causedBy?: CausedBy };
/** What the send path reads of its context: the legacy `ToolContext`, or a catalog tool's. */
type SendContext = Pick<ToolContext, "api" | "signal" | "now" | "turnContext">;
type SendResult = { seq: number; outcome: TurnOutcome | "sent" | "goal"; turnId?: string; reply?: string; replyTruncated?: boolean; answer?: string; answerTruncated?: true; hint?: string; pending?: SessionDetail["pending"]; session: SessionDetail };

/**
 * Post the turn (§7.4) and, with `wait`, block per §9.1; the result is read from the fresh snapshot. `checked` is the
 * snapshot the send was checked on. The baseline is the summary read right before the POST: the checks, the catalogue
 * read and the uploads take time, and a turn that ended meanwhile must not read as this message's outcome.
 */
async function dispatchTurn(ctx: SendContext, sessionId: string, checked: ThreadSnapshotPayload, body: TurnBody, wait: boolean, timeoutMs: number): Promise<SendResult> {
  const summary = await requireChatSession(ctx.api, sessionId);
  const baseline = turnBaseline(summary);
  const over = turnsOverBefore(checked, summary);
  const context = body.context ?? ctx.turnContext;
  const { seq } = await sendCommand(ctx.api, sessionId, "turn", {
    input: body.input,
    ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    interactionMode: body.interactionMode,
    ...(context?.length ? { context: [...context] } : {}),
    ...(body.causedBy ? { causedBy: body.causedBy } : {})
  });
  const { outcome, session } = wait ? await awaitTurn(ctx, sessionId, baseline, over, timeoutMs) : { outcome: "sent" as const, session: await chatDetail(ctx.api, sessionId) };
  return sendResult(seq, outcome, session, over);
}

/**
 * The turns already over when the message is posted: every settled turn of the snapshot the send was checked on, and
 * the summary's latest turn when settled. Their ids and replies answer earlier messages, never this one — even when
 * the baseline counts the session as running only because it is "starting" or its latest turn is a pending row.
 * Settled is decided by the state alone, as wait.ts and views.ts decide it: a running turn's `completedAt` can hold a
 * mid-turn placeholder stamp (turn-state.ts), and a steer into that turn is this message's.
 */
export function turnsOverBefore(checked: ThreadSnapshotPayload, summary: SessionSummary): ReadonlySet<string> {
  const over = new Set<string>();
  for (const t of [...checked.turns, summary.latestTurn]) {
    if (t?.turnId && SETTLED_TURN_STATES.has(t.state)) over.add(t.turnId);
  }
  return over;
}

/**
 * §9.1's wait, then the detail the result is built from. A needs-input the snapshot does not confirm is no outcome:
 * the summary trails the host by up to one poll, so right after respond_to_request answers it can still flag the request just
 * settled. The wait then goes on until a real outcome or the timeout — resuming on the session's next bus event (or
 * after STALE_RECHECK_MS), never looping on the stale summary. For the same lag, a verdict on a turn that was already
 * `over` when the message was posted is the list catching up, not this message's outcome: the wait rebases on it and
 * goes on. A session in error is a real failure whatever its latest turn.
 */
export async function awaitTurn(ctx: Pick<ToolContext, "api" | "signal" | "now">, sessionId: string, baseline: TurnBaseline, over: ReadonlySet<string>, timeoutMs: number): Promise<{ outcome: TurnOutcome; session: SessionDetail }> {
  // Elapsed time as wait.ts counts it: the larger of the caller's clock and the monotonic one.
  const startedAt = ctx.now();
  const startedMono = performance.now();
  const remaining = () => timeoutMs - Math.max(ctx.now() - startedAt, performance.now() - startedMono);
  let events = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const off = ctx.api.subscribe((event) => {
    if (event.channel !== "sessions" || (event.payload as { id?: unknown } | null)?.id !== sessionId) return;
    events += 1;
    if (event.type === "session.closed") closed = true;
    const w = wake;
    wake = null;
    w?.();
  });
  try {
    for (;;) {
      if (closed) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while waiting.`);
      const seen = events;
      const { outcome, summary } = await waitForTurn(ctx.api, sessionId, baseline, { timeoutMs: Math.max(0, remaining()), signal: ctx.signal, now: ctx.now });
      const latest = summary?.latestTurn?.turnId;
      if (outcome !== "needs-input" && outcome !== "timeout" && summary && summary.chatSessionStatus !== "error" && latest && over.has(latest)) {
        baseline = turnBaseline(summary);
        continue;
      }
      const session = await chatDetail(ctx.api, sessionId);
      if (outcome !== "needs-input" || session.pending.approvals.length > 0 || session.pending.questions.length > 0) return { outcome, session };
      const left = remaining();
      if (left <= 0 || ctx.signal.aborted) return { outcome: "timeout", session };
      // Nothing about the session moved since that verdict: wait until something does.
      if (events === seen) {
        await new Promise<void>((resolve) => {
          const resume = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", resume); wake = null; resolve(); };
          const timer = setTimeout(resume, Math.min(left, STALE_RECHECK_MS));
          ctx.signal.addEventListener("abort", resume, { once: true });
          wake = resume;
        });
      }
    }
  } finally {
    off();
  }
}

function sendResult(seq: number, outcome: SendResult["outcome"], session: SessionDetail, over: ReadonlySet<string>): SendResult {
  // The message's turn: one not over when it was posted — a new turn, or the running turn it steered (spec §7.4).
  const ours = (turnId: string | null | undefined): turnId is string => typeof turnId === "string" && turnId !== "" && !over.has(turnId);
  const settled = outcome !== "sent" && outcome !== "needs-input" && outcome !== "timeout";
  const replying = settled && session.lastReply !== undefined && ours(session.lastReply.turnId);
  const turnId = replying ? session.lastReply!.turnId : ours(session.chat.activeTurnId) ? session.chat.activeTurnId : undefined;
  const pending = session.pending.approvals.length || session.pending.questions.length ? session.pending : undefined;
  // The detail was fitted on its own; beside `pending`, returned twice, it can pass the cap. Fit it again in what the
  // rest leaves — `{…, "session":{}}` less the two bytes of that empty object — with the reply still in it as
  // `lastReply`, so a reply too long for the result is cut there, by bytes (`fitDetail`).
  const fitted = fitDetail(session, MAX_RESULT_BYTES - (resultBytes({ seq, outcome, turnId, pending, session: {} }) - 2));
  if (!replying || !fitted.lastReply) return { seq, outcome, ...(turnId ? { turnId } : {}), ...(pending ? { pending } : {}), session: fitted };
  // `reply` IS the detail's lastReply: returned once, which keeps a long reply inside the result cap. It is the
  // smaller spelling of it (no turnId, completedAt or key of its own), so the result still fits.
  const { lastReply, ...rest } = fitted;
  return { seq, outcome, turnId, reply: lastReply.text, ...(lastReply.truncated ? { replyTruncated: true } : {}), ...(pending ? { pending } : {}), session: rest };
}

/**
 * A `/goal` the host runs itself (goals §5.1, Codex): posted as the composer posts it, as a turn, and the host records
 * the message, starts NO turn and answers in a row — so there is no turn to wait for, and a turn wait would sit out its
 * whole timeout and then call the command a turn still running. With `wait`, the call waits for that answer instead
 * (`awaitGoalAnswer`): `outcome: "failed"` when the command failed, `"goal"` otherwise, with `answer` whenever a row
 * came and `hint` when none did. No `turnId` and no `reply`: the host records the message inside a running turn, but
 * no agent read it.
 */
async function dispatchGoalCommand(ctx: SendContext, sessionId: string, checked: ThreadSnapshotPayload, input: string, interactionMode: TurnBody["interactionMode"], wait: boolean, timeoutMs: number): Promise<SendResult> {
  // Every row the send was checked on: the answer is written after them.
  const seen = new Set(checked.items.map((item) => item.id));
  const windowMs = goalCommandChangesNothing(input, parseThreadGoal(checked.goal)) ? GOAL_ANSWER_SETTLE_MS : GOAL_ANSWER_WAIT_MS;
  const { seq } = await sendCommand(ctx.api, sessionId, "turn", { input, interactionMode });
  const answer = wait ? await awaitGoalAnswer(ctx, sessionId, input, seen, { timeoutMs, windowMs }) : null;
  const session = await chatDetail(ctx.api, sessionId);
  const pending = session.pending.approvals.length || session.pending.questions.length ? session.pending : undefined;
  // Cut by bytes, never beside a detail that already fills the cap: fitDetail cannot shrink an answer.
  const text = answer ? fitJsonBytes(answer.text, GOAL_ANSWER_BYTES) : null;
  const head = {
    seq, outcome: !wait ? "sent" as const : answer?.failed ? "failed" as const : "goal" as const,
    ...(text ? { answer: text.text, ...(text.truncated ? { answerTruncated: true as const } : {}) } : wait ? { hint: GOAL_NO_ANSWER_HINT } : {}),
    ...(pending ? { pending } : {})
  };
  // As sendResult fits it: beside `pending`, returned twice, the detail can pass the cap, so it is fitted again in what
  // the rest leaves — `{…, "session":{}}` less the two bytes of that empty object.
  return { ...head, session: fitDetail(session, MAX_RESULT_BYTES - (resultBytes({ ...head, session: {} }) - 2)) };
}

/**
 * Whether the goal the send was checked on makes this command one the host answers with no row (goals §5.1): a pause
 * of a paused goal, a resume of an active one — the argument read whole, in any case, as the host's parser reads it.
 * Its answer window is then a settle's worth, in case the goal moved meanwhile, rather than GOAL_ANSWER_WAIT_MS.
 */
function goalCommandChangesNothing(input: string, goal: ThreadGoal | null): boolean {
  const argument = input.trim().slice("/goal".length).trim().toLowerCase();
  return (argument === "pause" && goal?.status === "paused") || (argument === "resume" && goal?.status === "active");
}

/** A row answering a host `/goal`, and whether it settles the command. */
interface GoalAnswerRow { text: string; failed: boolean; settles: boolean }

/**
 * The rows a host `/goal` wrote, in log order: those after its own message — the last user message not in `seen` with
 * the command's text, or, when the window no longer shows it, every row not in `seen`. Three kinds answer (goals §5.1):
 * the status it asked for (`goal.status`) and why it failed (`goal.command.failed`), which the host appends LAST, once
 * the provider has answered, so either settles the command; and the goal's new state — a `goal.updated` row the GUI
 * shows, never a hidden `progress` tick — which can still have siblings on their way.
 */
function goalAnswerRows(items: readonly ThreadItem[], input: string, seen: ReadonlySet<string>): GoalAnswerRow[] {
  let from = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "message" && item.role === "user" && !seen.has(item.id) && item.text === input) { from = i + 1; break; }
  }
  const rows: GoalAnswerRow[] = [];
  for (const item of items.slice(from)) {
    if (item.kind !== "activity" || seen.has(item.id)) continue;
    if (item.activityKind === GOAL_COMMAND_FAILED_ACTIVITY_KIND) {
      const detail = (item.payload as { detail?: unknown } | null)?.detail;
      rows.push({ text: typeof detail === "string" && detail ? `${item.summary}: ${detail}` : item.summary, failed: true, settles: true });
    } else if (item.activityKind === GOAL_STATUS_ACTIVITY_KIND) {
      // A deploy's hold writes one of these too (goals §5.7, `heldForUpdate`): it answers nobody's `/goal`.
      if ((item.payload as { heldForUpdate?: unknown } | null)?.heldForUpdate === true) continue;
      rows.push({ text: item.summary, failed: false, settles: true });
    } else if (item.activityKind === GOAL_ACTIVITY_KIND) {
      // A row whose payload does not parse is still shown, by the GUI and by read_transcript.
      const update = parseGoalUpdatedPayload(item.payload);
      if (update === null || !isHiddenGoalChange(update.change)) rows.push({ text: item.summary, failed: false, settles: false });
    }
  }
  return rows;
}

/**
 * Wait for a host `/goal`'s answer (`goalAnswerRows`): done at a status or a failure row, or GOAL_ANSWER_SETTLE_MS after
 * the first goal update, so the rest of the same command is read with it. The window (`windowMs`) runs while the
 * session is up — the host starts one first when there is none, and a restart starts the window again — and the call's
 * `timeoutMs` bounds everything. The thread is read again on each bus event about the session, else every
 * GOAL_ANSWER_RECHECK_MS: a status answer moves no field of the summary. null when no row came.
 */
async function awaitGoalAnswer(ctx: SendContext, sessionId: string, input: string, seen: ReadonlySet<string>, opts: { timeoutMs: number; windowMs: number }): Promise<{ text: string; failed: boolean } | null> {
  // Elapsed time as wait.ts counts it, for every bound alike: the larger of the caller's clock and the monotonic one.
  const mark = () => ({ clock: ctx.now(), mono: performance.now() });
  const since = (at: { clock: number; mono: number }) => Math.max(ctx.now() - at.clock, performance.now() - at.mono);
  const started = mark();
  const answerOf = (rows: readonly GoalAnswerRow[]) => (rows.length === 0 ? null : { text: rows.map((r) => r.text).join("\n"), failed: rows.some((r) => r.failed) });
  let events = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const off = ctx.api.subscribe((event) => {
    if (event.channel !== "sessions" || (event.payload as { id?: unknown } | null)?.id !== sessionId) return;
    events += 1;
    if (event.type === "session.closed") closed = true;
    const w = wake;
    wake = null;
    w?.();
  });
  // Since when the session has been up, and since when the first goal update has been in.
  let up: { clock: number; mono: number } | null = null;
  let settling: { clock: number; mono: number } | null = null;
  try {
    for (;;) {
      if (closed) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while waiting.`);
      const heard = events;
      const snap = await readThread(ctx.api, sessionId);
      const rows = goalAnswerRows(snap.items, input, seen);
      if (rows.some((r) => r.settles)) return answerOf(rows);
      const status = snap.head.session.status;
      up = status === "ready" || status === "running" ? (up ?? mark()) : null;
      if (rows.length > 0 && settling === null) settling = mark();
      const left = Math.min(
        opts.timeoutMs - since(started),
        up === null ? Infinity : opts.windowMs - since(up),
        settling === null ? Infinity : GOAL_ANSWER_SETTLE_MS - since(settling)
      );
      if (left <= 0 || ctx.signal.aborted) return answerOf(rows);
      // Nothing about the session moved during that read: wait until something does, or look again shortly.
      if (events === heard) {
        await new Promise<void>((resolve) => {
          const resume = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", resume); wake = null; resolve(); };
          const timer = setTimeout(resume, Math.min(left, GOAL_ANSWER_RECHECK_MS));
          ctx.signal.addEventListener("abort", resume, { once: true });
          wake = resume;
        });
      }
    }
  } finally {
    off();
  }
}

export const sendMessage = defineTool({
  name: "send_message",
  title: "Send a message",
  description: "Send a message to a chat session (with optional image/file attachments, optionally in plan mode). With wait:true (default) it returns the agent's reply, or the question/approval it stopped on. While a turn is running the message steers it. On Codex the host runs `/goal …` itself: no turn starts, and outcome \"goal\" carries its `answer`.",
  input: {
    sessionId: sessionIdField,
    text: z.string().optional().describe("The message. Required unless attachments are given."),
    attachments: z.array(attachmentInputSchema).max(MAX_ATTACHMENTS).optional().describe(`Up to ${MAX_ATTACHMENTS}: {path} inside the sandbox, or {name, base64, mimeType?}.`),
    planMode: z.boolean().default(false).describe("Send in plan mode (the agent plans, does not edit). Only where the agent supports it; OpenCode uses options.agent=\"plan\"."),
    ...waitFields
  },
  annotations: MUTATING,
  async run(args, ctx) {
    const summary = await requireChatSession(ctx.api, args.sessionId);
    const text = (args.text ?? "").trim();
    if (!text && !args.attachments?.length) throw new ToolError("INVALID_ARGUMENT", "A message needs text or at least one attachment.");
    if (text.length > MAX_TURN_INPUT_CHARS) throw new ToolError("INVALID_ARGUMENT", `The message is ${text.length} characters; the limit is ${MAX_TURN_INPUT_CHARS}.`);
    // goals §5.1: where the HOST runs goals (Codex), `/goal …` is a goal command and never a prompt — the host's rule and
    // the composer's (`isGoalCommandText`, `capabilities.goals.command`).
    const goalText = isGoalCommandText(text);
    const view = goalText || args.planMode ? await buildViewContext(ctx.api) : null;
    const adapter = view?.adapterByRefId.get(summary.refId);
    const caps = adapter ? view?.capabilitiesByAdapter.get(adapter) : undefined;
    // Where a /goal goes is the agent's capabilities' to say: unread, the host might run it as a command while this call
    // waited on a turn that never starts — so it is refused, as plan mode is when they cannot be read.
    if (goalText && !caps) throw new ToolError("INVALID_ARGUMENT", `A /goal can't be routed for ${summary.refId} right now: its capabilities could not be read. Retry shortly.`);
    const hostGoal = goalText && parseGoalSupport(caps?.goals)?.command === "host";
    // The host refuses it too (`parseHostGoalCommand`), but only once the files are uploaded: refused here, none are.
    if (hostGoal && args.attachments?.length) throw new ToolError("INVALID_ARGUMENT", "A goal can't include attachments.");
    const checked = await readyToSend(ctx.api, summary, { hostGoal });
    if (args.planMode) {
      // The gate get_session reports as supports.planMode: capabilities that could not be read are no plan mode.
      if (!supportsFrom(caps).planMode) {
        throw new ToolError("INVALID_ARGUMENT", caps
          ? `${summary.refId} has no plan mode toggle${adapter === "opencode" ? ' — use update_session {options:{agent:"plan"}}' : ""}.`
          : `Plan mode can't be confirmed for ${summary.refId} right now: its capabilities could not be read. Retry shortly, or send without planMode.`);
      }
    }
    if (hostGoal) return dispatchGoalCommand(ctx, args.sessionId, checked, text, args.planMode ? "plan" : "default", args.wait, args.timeoutMs);
    const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, args.sessionId, args.attachments) : [];
    return dispatchTurn(ctx, args.sessionId, checked, { input: text, attachments, interactionMode: args.planMode ? "plan" : "default" }, args.wait, args.timeoutMs);
  }
});

/**
 * The plan the GUI's Implement button sends: the LATEST proposed plan, unless a later user message already
 * implemented it. That is the host's own `hasActionableProposedPlan` rule, judged on the snapshot just read
 * (`proposedPlan`, the one rule get_session and read_transcript use too) rather than on the summary flag, which
 * trails the host by up to one poll: a second call in that window would send the plan twice. A plan over the 16 KiB
 * wire cap arrives slimmed (`payload.truncated`) and is read back whole — the agent must never implement a cut plan.
 */
async function actionablePlanMarkdown(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload): Promise<string> {
  const latest = proposedPlan(snap.items);
  if (!latest) throw new ToolError("INVALID_ARGUMENT", "This session has no proposed plan to implement (get_session.plan); ask for one with send_message {planMode:true}.");
  if (!latest.actionable) throw new ToolError("INVALID_ARGUMENT", "The latest proposed plan was already sent for implementation; follow up with send_message.");
  const plan = latest.item;
  let payload = (plan.payload ?? {}) as { planMarkdown?: unknown; truncated?: unknown };
  if (payload.truncated === true) {
    const { item } = expectOk<ThreadItemResponse>(await api.request("GET", agentChatRoutes.item(sessionId, plan.id)));
    payload = (item?.kind === "activity" ? item.payload ?? {} : {}) as typeof payload;
  }
  const markdown = typeof payload.planMarkdown === "string" ? payload.planMarkdown : "";
  if (!markdown.trim()) throw new ToolError("INVALID_ARGUMENT", "The latest proposed plan has no text to implement.");
  return markdown;
}

const implementPlan = defineTool({
  name: "implement_plan",
  title: "Implement the proposed plan",
  description: "The GUI's Implement button: sends the agent's latest proposed plan back as 'PLEASE IMPLEMENT THIS PLAN' in default mode. To refine a plan instead, send_message with planMode:true.",
  input: { sessionId: sessionIdField, ...waitFields },
  annotations: MUTATING,
  async run(args, ctx) {
    const summary = await requireChatSession(ctx.api, args.sessionId);
    const snap = await readyToSend(ctx.api, summary);
    const plan = await actionablePlanMarkdown(ctx.api, args.sessionId, snap);
    return dispatchTurn(ctx, args.sessionId, snap, { input: buildPlanImplementationPrompt(plan), interactionMode: "default" }, args.wait, args.timeoutMs);
  }
});

export const readTranscript = defineTool({
  name: "read_transcript",
  title: "Read the transcript",
  // A list cut to fit ends in one element of its own shape counting the rest (transcript.ts `cutRow`): a changedFiles
  // "…N more files" string, a files row {path: "…N more files", additions, deletions} with the rest's line totals, an
  // attachments row {name: "…N more attachments", type: "omitted"}. The description has to say so: it reads as data.
  description: "What was said and done in a session, newest turns last: messages, tool calls, approvals, questions, plans, file changes, errors. `beforeTurn` reads older turns; `agentId` drills into a subagent. A list cut to fit (a checkpoint's files, a tool's changedFiles, a message's attachments) ends in a marker counting the rest (\"…12 more files\"; a files marker has their real line totals), not a real entry.",
  input: {
    sessionId: sessionIdField,
    turns: z.number().int().min(1).max(200).default(3).describe("How many turns to include: the latest ones, or those just before beforeTurn."),
    beforeTurn: z.number().int().min(2).optional().describe("Read the turns just before this turn number (2 to turnCount + 1) instead of the latest; turns older than the live window are read from the host's history index. To page back, pass the last result's olderTurns + 1. Turns that could not be read whole are named in unavailableTurns."),
    agentId: z.string().min(1).optional().describe("A subagent id from get_session.subagents to read its own timeline; a workflow agent's id is <coordinator>:wf:<slot>."),
    include: z.array(z.enum(["reasoning", "tools", "activity"])).default(["tools", "activity"]).describe("Extra row kinds; reasoning is opt-in."),
    maxChars: z.number().int().min(2_000).max(MAX_TRANSCRIPT_CHARS).default(40_000).describe("Size budget for the result, in UTF-8 bytes (max 55000; every tool result is capped at 60000 bytes). Over it, the transcript sheds reasoning, then tool detail, then its oldest rows, and cuts the latest reply last; the subagent list keeps at least a quarter when it needs it, plus whatever the transcript leaves unused.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const turnCount = startedTurns(snap.turns).length;
    if (args.beforeTurn !== undefined && args.beforeTurn > turnCount + 1) throw new ToolError("INVALID_ARGUMENT", beforeTurnRefusal(turnCount));
    // Turns older than the window come from the host's thread index; a page it cannot read is reported, never thrown.
    const range = transcriptRange(turnCount, args.turns, args.beforeTurn);
    const older = await readOlderHistory(api, args.sessionId, snap, range, args.agentId !== undefined ? { agentId: args.agentId } : {});
    const read = older.snapshot;
    // "" names no subagent: refused like any unknown id, never read as "the main view" (the schema refuses it first).
    // A subagent of an older turn is known by the rows a page brought back.
    if (args.agentId !== undefined && !read.roster.some((r) => r.id === args.agentId) && !read.items.some((i) => i.agentId === args.agentId)) {
      throw new ToolError("INVALID_ARGUMENT", `No subagent "${args.agentId}". Known: ${read.roster.map((r) => r.id).join(", ") || "none"}.`);
    }
    const unavailable = older.unavailable ? { turns: older.unavailable.turns, hint: unavailableHint(older.unavailable, range.end) } : undefined;
    const result = transcriptEntries(read, {
      turns: args.turns, ...(args.beforeTurn !== undefined ? { beforeTurn: args.beforeTurn } : {}), ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      include: new Set(args.include), maxChars: args.maxChars, windowItems: snap.items, ...(unavailable ? { unavailable } : {})
    });
    const hint = transcriptHint(result, unavailable?.hint);
    return hint ? { ...result, hint } : { ...result };
  }
});

/** The pre-catalog definitions (unserved; the legacy session toolkit and their tests run them until plan Task 14). */
export const messageTools: ToolDef[] = [sendMessage, implementPlan, readTranscript];

// ---------------------------------------------------------------------------
// The catalog tools (unified MCP design 2026-10-15 §4 rows 10 and 13, §8)
// ---------------------------------------------------------------------------

const MAX_REPLY_WAIT_SECONDS = 600;
const DEFAULT_REPLY_WAIT_SECONDS = 120;
/** The most unfinished children a chat's tools may have made (§5.6: every relation, agent-created only, §13 c). */
export const MAX_OPEN_CHILDREN = 6;
/** Agent depth (§5.6, D-15): agent-created delegate and opened links, a top-level chat's child being 1. */
export const MAX_AGENT_DEPTH = 2;
/** How long a child with no turn on its summary yet counts as unfinished (its first turn shows within a host poll). */
const NEW_CHILD_GRACE_MS = 60_000;
/** A chat caller's text, room left for the provenance header (§8.2). */
const CHAT_TEXT_MAX_CHARS = MAX_TURN_INPUT_CHARS - THREAD_MESSAGE_OVERHEAD_CHARS;
/** A reply's ceiling in a result, in UTF-8 bytes of its JSON. */
const REPLY_RESULT_MAX_BYTES = 40_000;

type ReplyMode = "wait" | "notify" | "none";


/** Refused for an external caller: the chat-only reply mode (§13: "External client calls a chat-only field"). */
function externalReply(reply: ReplyMode | undefined): void {
  if (reply === "notify") throw new ToolError("INVALID_ARGUMENT", 'reply "notify" delivers the answer as a message to the calling chat: it is for in-chat agents. Use "wait" or "none".');
}

/**
 * The subscription's idempotency key: one per tool call (the provider's call id), so a host that
 * re-sends the same call after a restart answers the same subscription, never a second message.
 */
function subscriptionKey(caller: ThreadCaller, tool: string, target: string): string {
  return createHash("sha256").update(`${caller.threadId}\0${caller.callId}\0${tool}\0${target}`).digest("hex").slice(0, 64);
}

/** What a reply wait answered, as a result: the reply (another chat's words), a notice, or that it will come as a message. */
function replyResult(wait: ReplyWaitResponse, target: { id: string; title: string }): Record<string, unknown> {
  switch (wait.outcome) {
    case "replied": {
      const turn = wait.turnId !== null ? { turnId: wait.turnId } : {};
      if (wait.state === "completed" && wait.reply === undefined) {
        return { outcome: "completed", ...turn, emptyReply: true, hint: replyNoticeText("empty", { title: target.title, sessionId: target.id }) };
      }
      const reply = wait.reply !== undefined ? fitJsonBytes(wait.reply, REPLY_RESULT_MAX_BYTES) : null;
      return {
        notice: UNTRUSTED_NOTICE,
        outcome: wait.state,
        ...turn,
        ...(reply ? { reply: reply.text, ...(reply.truncated ? { replyTruncated: true } : {}) } : {}),
        ...(wait.error !== undefined ? { error: wait.error } : {})
      };
    }
    case "notify":
      return {
        outcome: wait.reason === "needs-input" ? "needs-input" : "timeout",
        willNotify: true,
        hint:
          wait.reason === "needs-input"
            ? "That chat's turn is waiting for its user; its final reply will be delivered to you as a new message. End your turn or go on with other work."
            : "No reply yet; it will be delivered to you as a new message. End your turn or go on with other work; never poll."
      };
    case "closed":
      return { outcome: "closed", hint: `"${clipText(target.title, MAX_ECHO_CHARS)}" was closed before replying.` };
  }
}

/**
 * Send a chat caller's reply-requesting message (§8.3): the subscription is persisted before the
 * message is posted or queued as the target's next turn (Task 5's socket-only route); with `wait`,
 * the caller's waiter attaches until the bound turn's reply, the timeout or a question (then the
 * reply comes as a message: `willNotify`). A cancelled call releases its waiter.
 */
async function converse(
  ctx: CallContext,
  caller: ThreadCaller,
  target: { id: string; title: string },
  input: { text: string; reply: "wait" | "notify"; origin: Exclude<ThreadMessageOrigin, "reply">; interactionMode: "default" | "plan"; attachments?: AttachmentRef[]; timeoutSeconds: number; tool: string }
): Promise<Record<string, unknown>> {
  const causedBy = ctx.turn.causedBy;
  if (!causedBy) throw new ToolError("INTERNAL", "The turn this message causes has no exchange.");
  const sub = expectOk<ReplySubscriptionResponse>(
    await ctx.api.request("POST", agentChatRoutes.replySubscriptions(target.id), {
      body: {
        fromThreadId: caller.threadId,
        reply: input.reply,
        input: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        interactionMode: input.interactionMode,
        context: [threadMessageContext(caller.threadId)],
        causedBy,
        origin: input.origin,
        idempotencyKey: subscriptionKey(caller, input.tool, target.id)
      }
    })
  );
  const head = { delivery: sub.delivery, subscriptionId: sub.subscriptionId };
  if (input.reply === "notify") {
    return {
      ...head,
      willNotify: true,
      hint: sub.delivery === "queued" ? "That chat is busy: the message waits as its next turn, and its final reply will be delivered to you as a new message." : "Its final reply will be delivered to you as a new message; end your turn or go on with other work."
    };
  }
  const answered = await awaitReplySubscription(ctx.api, target.id, sub.subscriptionId, input.timeoutSeconds, ctx.signal);
  return { ...head, ...replyResult(answered, target) };
}

/** The refusal of a message to a chat that waits for its user, worded for a chat caller (who answers only its own children's questions). */
function chatPendingRefusal(snap: ThreadSnapshotPayload, sessionId: string): ToolError | null {
  const { approvals, userInputs } = snap.pending;
  if (approvals.length === 0 && userInputs.length === 0) return null;
  const open = [...approvals.map((a) => `approval ${a.requestId}`), ...userInputs.map((q) => `question ${q.requestId}`)].join(" and ");
  return new ToolError(
    "PENDING_REQUEST",
    `Session "${sessionId}" is waiting for its user to answer ${open}; it takes no steering message until they do. Send with reply "wait" or "notify" to queue the message as its next turn, or respond_to_request for a question of a chat you created.`,
    { approvals: approvals.map((a) => a.requestId), questions: userInputs.map((q) => q.requestId) }
  );
}

/**
 * Whether the target's agent has a plan mode, from the capability catalogue (as get_session reports
 * `supports.planMode`); null when the capabilities could not be read.
 */
async function targetPlanMode(api: ScopeContext["api"], refId: string): Promise<{ supported: boolean | null; adapter?: string }> {
  const view = await buildViewContext(api);
  const adapter = view.adapterByRefId.get(refId);
  const caps = adapter ? view.capabilitiesByAdapter.get(adapter) : undefined;
  return { supported: caps ? supportsFrom(caps).planMode : null, ...(adapter ? { adapter } : {}) };
}

/**
 * External `reply: "wait"` (§11): a working target gets the message as its NEXT turn, never a
 * steer. Posted with the host's `ifIdle` precondition (refused `TURN_NOT_IDLE`, unrecorded) and,
 * while the target works or waits for its user, posted again under the SAME command id once it is
 * idle — then waited on as a turn. Still busy at the timeout: nothing was sent (`sent: false`).
 */
async function dispatchNextTurn(ctx: SendContext, sessionId: string, body: TurnBody, timeoutMs: number): Promise<Record<string, unknown>> {
  const startedAt = ctx.now();
  const startedMono = performance.now();
  const remaining = () => timeoutMs - Math.max(ctx.now() - startedAt, performance.now() - startedMono);
  const commandId = randomUUID();
  for (;;) {
    const summary = await requireChatSession(ctx.api, sessionId);
    const checked = await readThread(ctx.api, sessionId);
    const baseline = turnBaseline(summary);
    const over = turnsOverBefore(checked, summary);
    try {
      const { seq } = await sendCommand(
        ctx.api,
        sessionId,
        "turn",
        { input: body.input, ...(body.attachments?.length ? { attachments: body.attachments } : {}), interactionMode: body.interactionMode, ifIdle: true },
        { commandId }
      );
      const { outcome, session } = await awaitTurn(ctx, sessionId, baseline, over, Math.max(0, remaining()));
      return { ...sendResult(seq, outcome, session, over) };
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== TURN_NOT_IDLE) throw error;
    }
    const left = remaining();
    const notSent = { outcome: "timeout", sent: false, hint: 'The session stayed busy for the whole wait, so the message was not sent. Send it again, or with reply "none" to steer its running turn.' };
    if (left <= 0) return notSent;
    // The host said busy: look again only once something about the session moved, so a busy reason
    // these reads cannot see (a compaction in flight) never turns into a re-post loop.
    const waited = await waitWhileWorking(ctx.api, [sessionId], { timeoutMs: left, signal: ctx.signal, now: ctx.now, until: (state) => state === "idle" || state === "failed", afterNextEvent: true });
    if (waited.reports.get(sessionId) === null) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while the message waited for it.`);
    if (waited.cancelled) throw new ToolError("CANCELLED", "The call was cancelled before the message was sent.");
    if (waited.timedOut) return notSent;
  }
}

/** Attachments as a card lists them: a path, or a name and size — never the bytes. */
function attachmentRows(attachments: readonly AttachmentInput[] | undefined): { label: string; value: string }[] {
  return (attachments ?? []).map((file, index) => ({
    label: `Attachment ${index + 1}`,
    value: "path" in file ? file.path : `${file.name} (${Math.floor((file.base64.length * 3) / 4)} bytes)`
  }));
}

/** Filesystem paths among the attachments, as the gate classifies them (each must lie inside a project, §5.1). */
function attachmentPaths(api: ScopeContext["api"], attachments: readonly AttachmentInput[] | undefined): string[] {
  return (attachments ?? []).flatMap((file) => ("path" in file ? [resolvePath(api.fsRoot, file.path)] : []));
}

const replyField = z.enum(["wait", "notify", "none"]);
const timeoutSecondsField = z.number().int().min(1).max(MAX_REPLY_WAIT_SECONDS).optional().describe(`For "wait" (default ${DEFAULT_REPLY_WAIT_SECONDS}).`);

// ---------------------------------------------------------------------------
// send_message (§4 row 13, §8.1)
// ---------------------------------------------------------------------------

export const sendMessageTool = defineCatalogTool({
  name: "send_message",
  title: "Send a message",
  description:
    "Message a chat. `reply` \"wait\" (default): returns the final reply of the turn this message causes (a working chat gets it as its next turn, never a steer), or early when that turn asks its user something, or at timeoutSeconds. \"none\": returns at once; a working chat's running turn is steered (refused while it waits for its user: PENDING_REQUEST). `implementPlan: true` sends its latest proposed plan to implement.",
  chatNote:
    "\"notify\": returns at once and delivers that turn's final reply to you later as a new message; prefer it for long work, never poll. A \"wait\" cut short goes on as notify (`willNotify`). Never message yourself; answer a [Sent by …] message in your final reply.",
  externalNote: "On Codex the host runs `/goal …` itself: no turn starts, and outcome \"goal\" carries its answer.",
  input: {
    sessionId: z.string().min(1).describe("From list_sessions."),
    text: z.string().optional().describe("The message."),
    attachments: z.array(attachmentInputSchema).max(MAX_ATTACHMENTS).optional().describe("{path} inside a project, or {name, base64}."),
    planMode: z.boolean().optional().describe("Send in plan mode."),
    implementPlan: z.boolean().optional().describe("Send its latest proposed plan to implement."),
    reply: replyField.optional(),
    timeoutSeconds: timeoutSecondsField
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "act",
  async scope(args, ctx) {
    const caller = threadCaller(ctx.caller);
    if (caller === null) {
      externalReply(args.reply);
      return { projects: [], sessions: [args.sessionId], reads: "none", writes: false, causesTurnIn: [] };
    }
    if (args.implementPlan === true && caller.planning) {
      throw new ToolError("PERMISSION_DENIED", "You are planning: implementing a plan starts editing work. Propose it in your plan instead.");
    }
    // A turn-causing Act (plan carries on, §5.3); its reply is read with the Act's own rights (§5.2).
    const claim = await sessionClaim(ctx, args.sessionId, { reads: "none", writes: false, causesTurnIn: [args.sessionId], self: "refuse" });
    const paths = attachmentPaths(ctx.api, args.attachments);
    return paths.length > 0 ? { ...claim, paths } : claim;
  },
  approval: async (args, ctx) =>
    sessionCard(ctx, args.sessionId, args.implementPlan ? "send its plan for implementation to" : "send a message to", [
      { label: "Reply", value: args.reply ?? "wait" },
      ...(args.planMode ? [{ label: "Mode", value: "plan" }] : []),
      ...attachmentRows(args.attachments)
    ], args.implementPlan ? undefined : args.text),
  annotations: CATALOG_MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const caller = threadCaller(ctx.caller);
    const reply: ReplyMode = args.reply ?? "wait";
    const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_REPLY_WAIT_SECONDS;
    const summary = await requireChatSession(ctx.api, args.sessionId);
    const text = (args.text ?? "").trim();
    if (args.implementPlan === true) {
      if (text || args.attachments?.length) throw new ToolError("INVALID_ARGUMENT", "implementPlan sends the session's own plan: give no text or attachments.");
      if (args.planMode === true) throw new ToolError("INVALID_ARGUMENT", "implementPlan sends in default mode: leave planMode out.");
    } else if (!text && !args.attachments?.length) {
      throw new ToolError("INVALID_ARGUMENT", "A message needs text or at least one attachment.");
    }
    const limit = caller === null ? MAX_TURN_INPUT_CHARS : CHAT_TEXT_MAX_CHARS;
    if (text.length > limit) throw new ToolError("INVALID_ARGUMENT", `The message is ${text.length} characters; the limit is ${limit}.`);
    return caller === null ? sendExternal(args, ctx, summary, text, reply, timeoutSeconds) : sendFromChat(args, ctx, caller, summary, text, reply, timeoutSeconds);
  }
});

type SendArgs = { sessionId: string; text?: string; attachments?: AttachmentInput[]; planMode?: boolean; implementPlan?: boolean };

async function sendExternal(args: SendArgs, ctx: CallContext, summary: SessionSummary, text: string, reply: ReplyMode, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const timeoutMs = timeoutSeconds * 1000;
  // goals §5.1: where the HOST runs goals (Codex), `/goal …` is a goal command and never a prompt.
  const goalText = args.implementPlan !== true && isGoalCommandText(text);
  const view = goalText || args.planMode ? await buildViewContext(ctx.api) : null;
  const adapter = view?.adapterByRefId.get(summary.refId);
  const caps = adapter ? view?.capabilitiesByAdapter.get(adapter) : undefined;
  if (goalText && !caps) throw new ToolError("INVALID_ARGUMENT", `A /goal can't be routed for ${summary.refId} right now: its capabilities could not be read. Retry shortly.`);
  const hostGoal = goalText && parseGoalSupport(caps?.goals)?.command === "host";
  if (hostGoal && args.attachments?.length) throw new ToolError("INVALID_ARGUMENT", "A goal can't include attachments.");
  // A steer is held back by an open request; a message for the next turn waits behind it (§4.1).
  const checked = reply === "none" || hostGoal ? await readyToSend(ctx.api, summary, { hostGoal }) : await readThread(ctx.api, summary.id);
  if (args.planMode && !supportsFrom(caps).planMode) {
    throw new ToolError("INVALID_ARGUMENT", caps
      ? `${summary.refId} has no plan mode toggle${adapter === "opencode" ? ' — use update_session {options:{agent:"plan"}}' : ""}.`
      : `Plan mode can't be confirmed for ${summary.refId} right now: its capabilities could not be read. Retry shortly, or send without planMode.`);
  }
  const interactionMode = args.planMode ? "plan" : "default";
  if (hostGoal) return { ...(await dispatchGoalCommand(ctx, summary.id, checked, text, interactionMode, reply === "wait", timeoutMs)) };
  const input = args.implementPlan === true ? buildPlanImplementationPrompt(await actionablePlanMarkdown(ctx.api, summary.id, checked)) : text;
  const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, summary.id, args.attachments) : [];
  const body: TurnBody = { input, attachments, interactionMode };
  if (reply === "none") return { ...(await dispatchTurn(ctx, summary.id, checked, body, false, timeoutMs)) };
  return dispatchNextTurn(ctx, summary.id, body, timeoutMs);
}

async function sendFromChat(args: SendArgs, ctx: CallContext, caller: ThreadCaller, summary: SessionSummary, text: string, reply: ReplyMode, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const sessions = await listSessions(ctx.api);
  const ref = chatThreadRef(caller, sessions, summary);
  const target = { id: summary.id, title: summary.title };
  // Plan carries on (§5.3): a planning caller's message plans too; an agent with no plan mode is refused.
  const interactionMode: "default" | "plan" = ctx.turn.interactionMode === "plan" || args.planMode === true ? "plan" : "default";
  if (interactionMode === "plan") {
    const plan = await targetPlanMode(ctx.api, summary.refId);
    if (plan.supported !== true) {
      if (ctx.turn.interactionMode === "plan") {
        throw new ToolError("PERMISSION_DENIED", `You are planning and ${summary.refId} has no plan mode, so it cannot be given work from here. Propose it in your plan instead.`);
      }
      throw new ToolError("INVALID_ARGUMENT", plan.supported === false ? `${summary.refId} has no plan mode toggle.` : `Plan mode can't be confirmed for ${summary.refId} right now. Retry shortly, or send without planMode.`);
    }
  }
  const checked = await readThread(ctx.api, summary.id);
  // The plan is the target's own words, sent as the GUI's Implement sends it (the host marks the plan
  // implemented by that prefix); the context chip, not a header, says another chat sent it.
  const input =
    args.implementPlan === true
      ? buildPlanImplementationPrompt(await actionablePlanMarkdown(ctx.api, summary.id, checked))
      : ctx.turn.provenance("sent", text, reply);
  const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, summary.id, args.attachments) : [];
  const legacyWait = (ctx as CallContext & { legacyAlias?: string }).legacyAlias === "thread_send" && reply === "wait";
  if (reply === "none" || legacyWait) {
    const pending = chatPendingRefusal(checked, summary.id);
    if (pending) throw pending;
    const body: TurnBody = { input, attachments, interactionMode, context: [threadMessageContext(caller.threadId)], ...(ctx.turn.causedBy ? { causedBy: ctx.turn.causedBy } : {}) };
    if (reply === "none") {
      const sent = await dispatchTurn(ctx, summary.id, checked, body, false, 0);
      return { sessionId: summary.id, outcome: sent.outcome, seq: sent.seq, ...(interactionMode === "plan" ? { planMode: true } : {}), ...ref };
    }
    // The legacy `thread_send {wait}` alias (§14.1): the old semantics — a working target is steered
    // and that turn waited on; a timeout just returns (nothing is delivered later).
    const sent = await asWaiter(caller.threadId, summary.id, () => dispatchTurn(ctx, summary.id, checked, body, true, timeoutSeconds * 1000));
    const { session: _detail, reply: words, replyTruncated, ...rest } = sent;
    return { ...(words !== undefined ? { notice: UNTRUSTED_NOTICE } : {}), sessionId: summary.id, ...rest, ...(words !== undefined ? { reply: words, ...(replyTruncated ? { replyTruncated } : {}) } : {}), ...ref };
  }
  const answered = await converse(ctx, caller, target, { text: input, reply, origin: "sent", interactionMode, attachments, timeoutSeconds, tool: "send_message" });
  const { notice, ...rest } = answered;
  return { ...(notice !== undefined ? { notice } : {}), sessionId: summary.id, ...rest, ...(interactionMode === "plan" ? { planMode: true } : {}), ...ref };
}

// ---------------------------------------------------------------------------
// create_session (§4 row 10, §4.1)
// ---------------------------------------------------------------------------

type AccountSource = "requested" | "inherited" | "family-default";

interface ResumeRow { id: string; agent: string; title: string; home: "system" | "account"; accountId?: string }

/** A delegated task's default tab title: "Task: " and the prompt's first line, cut short. */
function delegateTitle(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]!.trim();
  const cut = line.length > 60 ? `${line.slice(0, 59)}…` : line;
  return cut ? `Task: ${cut}` : "Task";
}

/** A child that has not finished: working, waiting for its user, or opened a moment ago with no turn yet. */
function unfinished(s: SessionSummary, now: number): boolean {
  if (s.hasPendingApprovals || s.hasPendingUserInput || s.chatPending === true) return true;
  if (s.chatSessionStatus === "running" || s.chatSessionStatus === "starting" || s.latestTurn?.state === "running" || s.latestTurn?.state === "pending" || s.goal?.continuing === true) return true;
  return !s.latestTurn && now - Date.parse(s.createdAt) < NEW_CHILD_GRACE_MS;
}

/** The agent depth of a tab: its lineage's recorded `delegationDepth`, else the counting links walked up the open tabs. */
function agentDepth(sessions: readonly SessionSummary[], threadId: string): number {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let depth = 0;
  const seen = new Set<string>();
  let current = byId.get(threadId);
  while (current?.lineage && !seen.has(current.id)) {
    if (current.lineage.delegationDepth !== undefined) return depth + current.lineage.delegationDepth;
    seen.add(current.id);
    if (current.lineage.relation === "delegate" || (current.lineage.relation === "opened" && current.lineage.agentCreated === true)) depth += 1;
    current = byId.get(current.lineage.parentThreadId);
  }
  return depth;
}

/**
 * The model a launch gets (D-23, `resolveLaunchModel`, the one function `list_agents` reports its
 * default with): the named one — legacy accepted and marked —, else the inherited one while the
 * catalogue still lists it, else the catalogue default (never a legacy model).
 */
function launchModel(agent: AgentView, requested: string | undefined, inherited: string | undefined): { slug: string; isLegacy: boolean } {
  if (requested !== undefined) {
    const model = findModel(agent, requested);
    return { slug: model.slug, isLegacy: model.isLegacy === true };
  }
  const own = inherited ? agent.models.find((model) => model.slug === inherited) : undefined;
  if (own) return { slug: own.slug, isLegacy: own.isLegacy === true };
  const catalogue: ProviderModel[] = agent.models.map((model) => ({ slug: model.slug, name: model.name, isDefault: model.isDefault, ...(model.isLegacy ? { isLegacy: true } : {}), capabilities: null }));
  const pick = resolveLaunchModel(catalogue);
  if (!pick) throw new ToolError("INVALID_ARGUMENT", `Still loading ${agent.id}'s models — retry in a moment (list_agents).`);
  return { slug: pick.slug, isLegacy: pick.isLegacy === true };
}

/** The account a launch names and where it came from (D-24): requested, this chat's (same agent), or the family default. */
function launchAccount(agent: AgentView, requested: string | undefined, inherited: string | undefined, resume: ResumeRow | undefined): { accountId?: string; source: AccountSource; note?: string } {
  // A transcript in a managed account's home is visible only from there: that account is forced (the GUI's `resumeAccountId`).
  if (resume?.home === "account" && resume.accountId) {
    if (requested !== undefined) validateAccountId(agent, requested);
    return { accountId: resume.accountId, source: requested === resume.accountId ? "requested" : "inherited", ...(requested === resume.accountId ? {} : { note: "The conversation is stored in this account's home, so it resumes under it." }) };
  }
  if (requested !== undefined) return { accountId: validateAccountId(agent, requested), source: "requested" };
  if (inherited) {
    try {
      return { accountId: validateAccountId(agent, inherited), source: "inherited" };
    } catch {
      return { source: "family-default", note: `This chat's account is not usable with ${agent.id} any more, so the family default was used.` };
    }
  }
  return { source: "family-default" };
}

/** A `cwd` argument inside the target project: absolute, or relative to the project; an existing directory. */
async function cwdInProject(api: ScopeContext["api"], projectPath: string, input: string): Promise<string> {
  const cwd = resolvePath(projectPath, input);
  const [real, root] = await Promise.all([canonicalPath(api, cwd), canonicalPath(api, projectPath)]);
  const rel = relativePath(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("PERMISSION_DENIED", `cwd "${clipText(input, MAX_ECHO_CHARS)}" is not inside the project the session opens in.`);
  const directory = await stat(real).then((info) => info.isDirectory(), () => false);
  if (!directory) throw new ToolError("INVALID_ARGUMENT", `cwd "${clipText(input, MAX_ECHO_CHARS)}" is not an existing directory.`);
  return cwd;
}

interface CreateArgs {
  project?: string;
  agent?: string;
  model?: string;
  options?: Record<string, string | boolean>;
  runtimeMode?: RuntimeMode;
  accountId?: string;
  title?: string;
  cwd?: string;
  resume?: { conversationId: string };
  prompt?: string;
  reply?: ReplyMode;
  timeoutSeconds?: number;
  delegate?: boolean;
}

/** The project a create opens in: the named one, else (chat) the caller's own. */
async function createTarget(api: ScopeContext["api"], caller: ThreadCaller | null, project: string | undefined): Promise<string> {
  if (project !== undefined) return (await resolveProject(api, project)).path;
  if (caller === null) throw new ToolError("INVALID_ARGUMENT", "project is required: an absolute path or \"<workspace>/<project>\".");
  if (caller.projectPath === "") throw new ToolError("INVALID_ARGUMENT", "This chat belongs to no project: name the project to open the chat in (list_projects).");
  return caller.projectPath;
}

/** The conversation a resume names, from the project's list. */
async function resumeRowFor(api: ScopeContext["api"], projectPath: string, conversationId: string): Promise<ResumeRow> {
  const res = expectOk<AgentConversationsResponse>(await api.request("GET", "/api/agents/conversations", { query: { path: projectPath } }));
  const row = res.conversations.find((c) => c.id === conversationId);
  if (!row) throw new ToolError("INVALID_ARGUMENT", `No conversation "${clipText(conversationId, MAX_ECHO_CHARS)}" in this project; pick one from list_conversations.`);
  return { id: row.id, agent: row.agentRefId, title: row.title, home: row.home ?? "system", ...(row.accountId ? { accountId: row.accountId } : {}) };
}

/** The reply mode a create asks for (§4.1): chat `delegate` → notify, else none; `wait`/`notify` need a prompt. */
function createReply(args: CreateArgs, chat: boolean): ReplyMode {
  const reply = args.reply ?? (chat && args.delegate === true ? "notify" : "none");
  if (reply !== "none" && args.prompt === undefined) throw new ToolError("INVALID_ARGUMENT", `reply "${reply}" answers a prompt: give the first message in \`prompt\`.`);
  return reply;
}

export const createSessionTool = defineCatalogTool({
  name: "create_session",
  title: "Open a chat session",
  description:
    "Open a chat tab for an agent in a project, or resume a conversation (list_conversations); list_agents lists agents, models, options, modes and accounts. With `prompt` it starts at once: `reply` \"wait\" returns that turn's final reply (or at timeoutSeconds), \"none\" returns at once. The result says what the session got: model (`isLegacy` if legacy), mode, account and `accountSource` (requested, inherited or family-default).",
  chatNote:
    "Defaults: this chat's project, agent, mode (only narrower) and, same agent, its model, options and account. `prompt` (self-contained) is required unless resuming. `delegate: true` makes it your task: its final reply is the result, delivered to you as a message (reply default \"notify\", else \"none\"). Limits: 6 unfinished chats you opened, 2 levels deep.",
  externalNote: "`project` is required; runtimeMode defaults to full-access, reply to \"none\".",
  input: {
    project: z.string().min(1).optional().describe("Path or \"workspace/project\"."),
    agent: z.string().min(1).max(64).optional().describe("From list_agents."),
    // min(1): an empty model would read as none, so the default model would launch in its place.
    model: z.string().min(1).max(200).optional(),
    options: optionsSchema.optional().describe("By id, e.g. {\"effort\":\"high\"}."),
    runtimeMode: runtimeModeSchema.optional(),
    accountId: z.string().min(1).max(200).optional().describe("From list_agents, or \"system\"."),
    title: z.string().trim().min(1).max(300).optional(),
    cwd: z.string().min(1).optional().describe("Inside the project; default: the project."),
    resume: z.object({ conversationId: z.string().min(1) }).optional().describe("From list_conversations."),
    prompt: z.string().trim().min(1).max(CHAT_TEXT_MAX_CHARS).optional().describe("The first message."),
    reply: replyField.optional(),
    timeoutSeconds: timeoutSecondsField,
    delegate: z.boolean().optional()
  },
  chatOnlyInput: ["delegate"],
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "act",
  async scope(args, ctx) {
    const caller = threadCaller(ctx.caller);
    if (caller === null) {
      externalReply(args.reply);
      return { projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] };
    }
    if (args.prompt === undefined && args.resume === undefined) throw new ToolError("INVALID_ARGUMENT", "prompt is required: the chat's first message, self-contained.");
    createReply(args, true);
    const path = await createTarget(ctx.api, caller, args.project);
    const project = await canonicalProject(ctx.api, path);
    if (project === null) throw new ToolError("PROJECT_NOT_FOUND", `No project at "${clipText(args.project ?? path, MAX_ECHO_CHARS)}". Use list_projects.`);
    return {
      projects: [project.canonical],
      sessions: [],
      // A resumed conversation's words come into a tab this chat can read.
      reads: args.resume !== undefined ? "content" : "none",
      writes: false,
      // The first turn is agent-caused (§8.4); the opened chat runs no broader than this one (turn policy a).
      causesTurnIn: args.prompt !== undefined ? [NEW_SESSION] : [],
      ...(args.cwd !== undefined ? { paths: [resolvePath(project.canonical, args.cwd)] } : {})
    };
  },
  async approval(args, ctx) {
    const caller = threadCaller(ctx.caller);
    const path = await createTarget(ctx.api, caller, args.project);
    const project = await canonicalProject(ctx.api, path);
    const where = project ? `${project.workspace}/${project.name}` : clipText(path, MAX_ECHO_CHARS);
    const rows = [
      { label: "Action", value: args.delegate ? "delegate a task to a new chat" : args.resume ? "resume a conversation" : "open a chat" },
      { label: "Project", value: where },
      { label: "Agent", value: args.agent ?? "this chat's" },
      ...(args.model ? [{ label: "Model", value: args.model }] : []),
      ...(args.options ? [{ label: "Options", value: JSON.stringify(args.options) }] : []),
      { label: "Permission mode", value: args.runtimeMode ?? (caller ? caller.runtimeMode : "full-access") },
      ...(args.accountId ? [{ label: "Account", value: args.accountId }] : []),
      ...(args.cwd ? [{ label: "Working directory", value: args.cwd }] : []),
      ...(args.resume ? [{ label: "Resume", value: args.resume.conversationId }] : []),
      ...(args.prompt !== undefined ? [{ label: "Reply", value: args.reply ?? (args.delegate ? "notify" : "none") }] : [])
    ];
    const sections: ApprovalPreviewSection[] = [{ kind: "fields", title: "Request", rows }];
    if (args.prompt !== undefined) sections.push({ kind: "text", title: "First message", text: args.prompt });
    return { title: `${caller ? agentLabel(caller) : "An agent"} wants to open a chat in ${where}`, scopeLabel: `Project ${where}`, sections };
  },
  annotations: CATALOG_MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const caller = threadCaller(ctx.caller);
    return caller === null ? createExternal(args, ctx) : createFromChat(args, ctx, caller);
  }
});

/** The first message's outcome, for a create that carried a prompt. */
type FirstTurn = Record<string, unknown>;

async function createExternal(args: CreateArgs, ctx: CallContext): Promise<Record<string, unknown>> {
  const { api } = ctx;
  const projectPath = await createTarget(api, null, args.project);
  const reply = createReply(args, false);
  const resume = args.resume ? await resumeRowFor(api, projectPath, args.resume.conversationId) : undefined;
  const refId = args.agent ?? resume?.agent;
  if (!refId) throw new ToolError("INVALID_ARGUMENT", "agent is required (see list_agents).");
  if (resume && args.agent && resume.agent !== args.agent) throw new ToolError("INVALID_ARGUMENT", `Conversation "${resume.id}" belongs to ${resume.agent}, not ${args.agent}.`);
  const agent = findAgent(await loadAgents(api, { includeLegacyModels: true }), refId);
  if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
  const model = launchModel(agent, args.model, undefined);
  const selection = resolveModelSelection(agent, { model: model.slug, ...(args.options !== undefined ? { options: args.options } : {}) });
  const account = launchAccount(agent, args.accountId, undefined, resume);
  const cwd = args.cwd === undefined ? projectPath : await cwdInProject(api, projectPath, args.cwd);
  const running = (await listSessions(api, projectPath)).filter((s) => s.status === "running").length;
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); close some first.`);
  const chat: CreateAgentChatSessionFields = {
    ...(account.accountId ? { accountId: account.accountId } : {}),
    modelSelection: { model: selection.model, options: selection.options },
    runtimeMode: args.runtimeMode ?? "full-access",
    ...(resume ? { resume: { home: resume.home, conversationId: resume.id } } : {})
  };
  const body: CreateSessionRequest = { kind: "agent-chat", refId, projectPath, cwd, title: args.title ?? (resume?.title || agent.name), ...(account.accountId ? { accountId: account.accountId } : {}), chat };
  const summary = expectOk<SessionSummary>(await api.request("POST", "/api/sessions", { body }));
  const created = { sessionId: summary.id, accountId: summary.accountId || account.accountId || "system", accountSource: account.source, ...(account.note ? { accountNote: account.note } : {}), ...(model.isLegacy ? { isLegacy: true } : {}) };
  let first: FirstTurn = {};
  if (args.prompt !== undefined) {
    try {
      const checked = await readThread(api, summary.id);
      const turn: TurnBody = { input: args.prompt, interactionMode: "default" };
      first = reply === "wait" ? await dispatchNextTurn(ctx, summary.id, turn, (args.timeoutSeconds ?? DEFAULT_REPLY_WAIT_SECONDS) * 1000) : { ...(await dispatchTurn(ctx, summary.id, checked, turn, false, 0)) };
    } catch (error) {
      throw createdButFailed(summary.id, "its first message could not be sent", error, "Send it with send_message; do not open another.");
    }
    // The first turn's own detail is the session's: returned once, as `session`.
    const { session, ...outcome } = first as { session?: unknown };
    if (session !== undefined) return { ...created, firstTurn: outcome, session };
    first = { firstTurn: outcome };
  }
  try {
    return { ...created, ...first, session: await chatDetail(api, summary.id) };
  } catch (error) {
    throw createdButFailed(summary.id, "it could not be read", error, "");
  }
}

/** A failure after the tab exists: the error names it, so the caller does not open a second one. */
function createdButFailed(sessionId: string, what: string, error: unknown, advice: string): ToolError {
  const failure = toSafeToolError(error).structuredContent as { code: string; message: string; detail?: unknown };
  const detail = failure.detail !== null && typeof failure.detail === "object" && !Array.isArray(failure.detail) ? (failure.detail as Record<string, unknown>) : {};
  return new ToolError(failure.code, `Session ${sessionId} was created but ${what}: ${failure.message}${advice ? ` ${advice}` : ""}`, { ...detail, sessionId, created: true });
}

async function createFromChat(args: CreateArgs, ctx: CallContext, caller: ThreadCaller): Promise<Record<string, unknown>> {
  const { api } = ctx;
  const projectPath = await createTarget(api, caller, args.project);
  const reply = createReply(args, true);
  const delegate = args.delegate === true;
  const sessions = await listSessions(api);
  const tab = sessions.find((s) => s.id === caller.threadId);
  if (!tab) throw new ToolError("THREAD_NOT_FOUND", "This chat thread is no longer open.");
  // Caps (§5.6): the project's open chats, this chat's unfinished children, agent depth.
  const canonical = await canonicalProject(api, projectPath);
  const roots = new Map<string, string | undefined>();
  let running = 0;
  for (const s of sessions.filter((tab) => tab.status === "running")) {
    if (!roots.has(s.projectPath)) roots.set(s.projectPath, (await canonicalProject(api, s.projectPath))?.canonical);
    if (s.projectPath === projectPath || (canonical !== null && roots.get(s.projectPath) === canonical.canonical)) running += 1;
  }
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) throw new ToolError("SESSION_BUSY", `${running} chats are open in that project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); the user has to close some first.`);
  const now = ctx.now();
  const open = sessions.filter((s) => s.lineage?.parentThreadId === caller.threadId && s.lineage.agentCreated === true && unfinished(s, now)).length;
  if (open >= MAX_OPEN_CHILDREN) {
    throw new ToolError("DELEGATION_LIMIT", `This chat already has ${open} unfinished chats it opened (limit ${MAX_OPEN_CHILDREN}). Wait for their replies, or stop one with control_session.`);
  }
  const depth = agentDepth(sessions, caller.threadId) + 1;
  if (depth > MAX_AGENT_DEPTH) {
    throw new ToolError("DELEGATION_LIMIT", `This chat was itself opened by another agent ${depth - 1} level${depth === 2 ? "" : "s"} deep; agents may open chats only ${MAX_AGENT_DEPTH} levels deep. Do the work here, or report back.`);
  }
  const resume = args.resume ? await resumeRowFor(api, projectPath, args.resume.conversationId) : undefined;
  const refId = args.agent ?? resume?.agent ?? tab.refId;
  if (resume && args.agent && resume.agent !== args.agent) throw new ToolError("INVALID_ARGUMENT", `Conversation "${resume.id}" belongs to ${resume.agent}, not ${args.agent}.`);
  const agent = findAgent(await loadAgents(api, { includeLegacyModels: true }), refId);
  if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
  // Turn policy (a): this chat's permission mode, or a narrower one — never broader.
  const runtimeMode = openedThreadRuntimeMode(caller, args.runtimeMode);
  // Turn policy (b): a planning caller's first turn plans too; an agent with no plan mode is refused.
  const interactionMode = ctx.turn.interactionMode;
  if (args.prompt !== undefined && interactionMode === "plan" && !agent.supports.planMode) {
    throw new ToolError("PERMISSION_DENIED", `You are planning and ${refId} has no plan mode, so it cannot be given work from here. Propose it in your plan instead.`);
  }
  const sameAgent = refId === tab.refId;
  const current = sameAgent ? (await readThread(api, caller.threadId)).head.modelSelection : undefined;
  const model = launchModel(agent, args.model, current?.model);
  const selection = resolveModelSelection(agent, { model: model.slug, ...(args.options !== undefined ? { options: args.options } : {}), ...(current ? { current } : {}) });
  const account = launchAccount(agent, args.accountId, sameAgent && tab.accountId ? tab.accountId : undefined, resume);
  const ownProject = canonical !== null && canonical.canonical === caller.projectPath;
  const cwd = args.cwd !== undefined ? await cwdInProject(api, projectPath, args.cwd) : ownProject && caller.cwd ? caller.cwd : projectPath;
  const chat: CreateAgentChatSessionFields = {
    ...(account.accountId ? { accountId: account.accountId } : {}),
    modelSelection: { model: selection.model, options: selection.options },
    runtimeMode,
    ...(resume ? { resume: { home: resume.home, conversationId: resume.id } } : {}),
    // The caller's own child (§13 c): honoured because this request's principal is the caller's agent.
    lineage: { parentThreadId: caller.threadId, relation: delegate ? "delegate" : "opened", agentCreated: true }
  };
  const title = args.title ?? (resume?.title || (delegate && args.prompt !== undefined ? delegateTitle(args.prompt) : agent.name));
  const body: CreateSessionRequest = { kind: "agent-chat", refId, projectPath, cwd, title, ...(account.accountId ? { accountId: account.accountId } : {}), chat };
  const summary = expectOk<SessionSummary>(await api.request("POST", "/api/sessions", { body }));
  const relation = delegate ? "delegate" : "opened";
  const created = {
    sessionId: summary.id,
    title: summary.title,
    agent: refId,
    model: selection.model,
    ...(model.isLegacy ? { isLegacy: true } : {}),
    options: Object.fromEntries(selection.options.map((option) => [option.id, option.value])),
    runtimeMode,
    accountId: summary.accountId || account.accountId || "system",
    accountSource: account.source,
    ...(account.note ? { accountNote: account.note } : {}),
    relation,
    ...(args.prompt !== undefined && interactionMode === "plan" ? { planMode: true } : {})
  };
  const ref = chatThreadRef(caller, [...sessions, summary], summary, relation);
  if (args.prompt === undefined) return { ...created, ...ref };
  const origin: Exclude<ThreadMessageOrigin, "reply"> = delegate ? "delegated" : "opened";
  const input = ctx.turn.provenance(origin, args.prompt, reply);
  let first: Record<string, unknown>;
  try {
    if (reply === "none") {
      const { seq } = await sendCommand(api, summary.id, "turn", {
        input,
        interactionMode,
        // The marker that the message is the calling chat's, not the user's.
        context: [threadMessageContext(caller.threadId)],
        ...(ctx.turn.causedBy ? { causedBy: ctx.turn.causedBy } : {})
      });
      first = { outcome: "sent", seq };
    } else {
      first = await converse(ctx, caller, { id: summary.id, title: summary.title }, { text: input, reply, origin, interactionMode, timeoutSeconds: args.timeoutSeconds ?? DEFAULT_REPLY_WAIT_SECONDS, tool: "create_session" });
    }
  } catch (error) {
    throw createdButFailed(summary.id, "its first message could not be sent", error, "Send it with send_message; do not open another.");
  }
  const { notice, ...rest } = first;
  return { ...(notice !== undefined ? { notice } : {}), ...created, ...rest, ...ref };
}

/**
 * This family in the catalog (`../catalog/index.ts`). TRANSITIONAL: the pre-catalog `read_transcript`
 * rides here until plan Task 7's sessions family serves it (`./sessions.ts`); merging Task 7 drops
 * this entry (a duplicate name fails `buildCatalog`).
 */
export const messagesFamily: readonly AnyOrquesterTool[] = [createSessionTool, sendMessageTool, ...legacyExternalTools([readTranscript])];
