// Catalog family module `messages` (Conversation: create_session, send_message) — plan Task 8 (unified MCP, Wave 3).
//
// The agent-to-agent conversation (spec §4 rows 10 and 13, §8): `create_session` opens a chat —
// for a chat caller as its `opened` child or its `delegate` task, `agentCreated` (§13 c) — and
// `send_message` talks to one, each with a reply mode: `wait` returns the final reply of the turn
// the message causes, `notify` (chat only) delivers it later as a new message, `none` is fire and
// forget. Reply-requesting messages go through the reply-subscription routes (Task 5's services,
// socket-only): persisted before posting, queued as the target's next turn — never a steer.
//
// The steer-and-await path (`dispatchTurn` with `wait`, `awaitTurn`) serves an old agent host's
// `thread_send {wait}` alias (spec §14.1); `reply: "none"` is `dispatchTurn` without the wait.
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { AgentConversationsResponse, ApprovalPreviewSection, CreateSessionRequest, SessionSummary } from "@orquester/api";
import { agentChatRoutes, buildPlanImplementationPrompt, GOAL_ACTIVITY_KIND, GOAL_COMMAND_FAILED_ACTIVITY_KIND, GOAL_STATUS_ACTIVITY_KIND, isGoalCommandText, isHiddenGoalChange, MAX_TURN_INPUT_CHARS, parseGoalSupport, parseGoalUpdatedPayload, parseThreadGoal, replyNoticeText, resolveLaunchModel, THREAD_MESSAGE_OVERHEAD_CHARS, threadMessageContext, TURN_NOT_IDLE, UNTRUSTED_NOTICE, WAIT_CYCLE, type AttachmentRef, type CausedBy, type ComposerContextRecord, type CreateAgentChatSessionFields, type ProviderModel, type ReplySubscriptionResponse, type ReplyWaitResponse, type RuntimeMode, type ThreadGoal, type ThreadItem, type ThreadItemResponse, type ThreadMessageOrigin, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { findAgent, findModel, loadAgents, resolveModelSelection, supportsFrom, validateAccountId, type AgentView } from "../agents.ts";
import { resolveProfileArg } from "../profiles.ts";
import { canonicalProject, realPathInSandbox, resolveProject } from "../addressing.ts";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { attachmentInputSchema, MAX_ATTACHMENTS, uploadInlineAttachments, type AttachmentInput } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { expectOk, ToolError } from "../errors.ts";
import { listSessions, readThread, readThreadHead, requireChatSession, sendCommand } from "../reads.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes, toSafeToolError } from "../result.ts";
import { proposedPlan } from "../transcript.ts";
import { buildViewContext, chatDetail, fitDetail, SETTLED_TURN_STATES, type SessionDetail } from "../views.ts";
import { awaitReplySubscription, turnBaseline, waitForTurn, waitWhileWorking, type TurnBaseline, type TurnOutcome } from "../wait.ts";
import { defineTool, MUTATING, type AnyOrquesterTool, type CallContext, type ScopeContext, type ThreadCaller } from "../catalog/contract.ts";
import { NEW_SESSION, openedThreadRuntimeMode, runtimeModesUpTo } from "../gate/turn-policy.ts";
import { asWaiter } from "../../agent-chat/waits.ts";
import { MAX_RUNNING_SESSIONS_PER_PROJECT, optionsSchema, runtimeModeSchema } from "./sessions.ts";
import { agentLabel, chatThreadRef, sessionCard, sessionClaim, threadCaller } from "./session-access.ts";

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
/** What the send path reads of a catalog tool's context. */
type SendContext = Pick<CallContext, "api" | "signal" | "now">;
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
  const context = body.context;
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
function turnsOverBefore(checked: ThreadSnapshotPayload, summary: SessionSummary): ReadonlySet<string> {
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
async function awaitTurn(ctx: SendContext, sessionId: string, baseline: TurnBaseline, over: ReadonlySet<string>, timeoutMs: number): Promise<{ outcome: TurnOutcome; session: SessionDetail }> {
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

/**
 * A send's result with its session detail fitted beside it (the reply cut first, then the plan): the
 * external `send_message` and `create_session` answer it whole (`reply: "none"`, and `"wait"` through
 * `dispatchNextTurn`); an old host's `thread_send {wait}` alias (`sendFromChat`'s legacy path) answers
 * the same reply without the detail.
 */
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


/**
 * The provenance-headed text of a turn a chat causes (§8.2), through the executor's one header
 * builder. With `reply: "none"` the header tells the receiver how to answer — truthfully: a receiver
 * narrower than the sender may not message it (never broader, §5.3), so it is told its answer stays
 * visible in its own chat instead (`senderReachable`).
 */
function provenanceFor(ctx: CallContext, caller: ThreadCaller, origin: Exclude<ThreadMessageOrigin, "reply">, text: string, reply: ReplyMode, receiverMode: RuntimeMode): string {
  return ctx.turn.provenance(origin, text, reply, { senderReachable: runtimeModesUpTo(receiverMode).includes(caller.runtimeMode) });
}

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
 * A wait that failed after its message went out, said truthfully (the message is never to be sent
 * again): a wait refused for a cycle or while Orquester restarts leaves the subscription without a
 * waiter, so its reply is delivered as a message; another wait holding it gets it there; a
 * subscription that is gone delivers nothing here.
 */
function waitFailure(failure: { code: string; message: string }): Record<string, unknown> {
  const why = `${failure.code}: ${failure.message}`;
  switch (failure.code) {
    case WAIT_CYCLE:
    case "HOST_UNAVAILABLE":
      return { willNotify: true, hint: `The message was sent, but its reply could not be waited for here (${why}). Its final reply will be delivered to you as a new message; do not send it again.` };
    case "COMMAND_REJECTED":
      return { willNotify: false, hint: `The message was sent, and another wait of this chat already holds its reply (${why}): the reply returns there, not here. Do not send it again.` };
    case "THREAD_NOT_FOUND":
      return { willNotify: false, hint: `The message was sent, but its reply subscription is gone (${why}) — the chat may have closed. No reply will come here; get_session shows its state. Do not send it again.` };
    default:
      return { willNotify: false, hint: `The message was sent, but waiting for its reply failed (${why}). Whether the reply arrives as a message is unknown; check with get_session or read_transcript before sending again.` };
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
  let answered: ReplyWaitResponse;
  try {
    answered = await awaitReplySubscription(ctx.api, target.id, sub.subscriptionId, input.timeoutSeconds, ctx.signal, ctx.caller.kind === "thread" ? ctx.caller.delivered : undefined);
  } catch (error) {
    // The message is saved and sent (or queued): only the wait failed — never a failed send the
    // agent would repeat. What happens to the reply depends on why the wait failed.
    const failure = toSafeToolError(error).structuredContent as { code: string; message: string };
    return { ...head, ...waitFailure(failure) };
  }
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
 * Inline attachments (`upload`) are uploaded only once the session reads idle, right before the
 * first post, and reused by every retry; the call stops before any post once it is cancelled.
 */
async function dispatchNextTurn(ctx: SendContext, sessionId: string, body: TurnBody, timeoutMs: number, upload?: () => Promise<AttachmentRef[]>): Promise<Record<string, unknown>> {
  const startedAt = ctx.now();
  const startedMono = performance.now();
  const remaining = () => timeoutMs - Math.max(ctx.now() - startedAt, performance.now() - startedMono);
  const commandId = randomUUID();
  const notSent = { outcome: "timeout", sent: false, hint: 'The session stayed busy for the whole wait, so the message was not sent. Send it again, or with reply "none" to steer its running turn.' };
  const cancelled = () => new ToolError("CANCELLED", "The call was cancelled before the message was sent.");
  /** Until the session reads idle (or failed); `afterNextEvent` once the host refused a post. */
  const untilIdle = async (afterNextEvent: boolean): Promise<"idle" | "timeout"> => {
    const left = remaining();
    if (left <= 0) return "timeout";
    const waited = await waitWhileWorking(ctx.api, [sessionId], { timeoutMs: left, signal: ctx.signal, now: ctx.now, until: (state) => state === "idle" || state === "failed", afterNextEvent });
    if (waited.reports.get(sessionId) === null) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while the message waited for it.`);
    if (waited.cancelled || ctx.signal.aborted) throw cancelled();
    return waited.timedOut ? "timeout" : "idle";
  };
  let attachments = body.attachments;
  if (upload !== undefined) {
    // Nothing is uploaded for a message that may never be sent: first the session must read idle.
    if ((await untilIdle(false)) === "timeout") return notSent;
    attachments = await upload();
  }
  for (;;) {
    if (ctx.signal.aborted) throw cancelled();
    const summary = await requireChatSession(ctx.api, sessionId);
    const checked = await readThread(ctx.api, sessionId);
    const baseline = turnBaseline(summary);
    const over = turnsOverBefore(checked, summary);
    if (ctx.signal.aborted) throw cancelled();
    try {
      const { seq } = await sendCommand(
        ctx.api,
        sessionId,
        "turn",
        { input: body.input, ...(attachments?.length ? { attachments } : {}), interactionMode: body.interactionMode, ifIdle: true },
        { commandId }
      );
      const { outcome, session } = await awaitTurn(ctx, sessionId, baseline, over, Math.max(0, remaining()));
      return { ...sendResult(seq, outcome, session, over) };
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== TURN_NOT_IDLE) throw error;
    }
    // The host said busy: look again only once something about the session moved, so a busy reason
    // these reads cannot see (a compaction in flight) never turns into a re-post loop. The uploaded
    // attachments ride every retry (a message the host never took leaves them to its unreferenced-
    // attachment sweep only in that last race).
    if ((await untilIdle(true)) === "timeout") return notSent;
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

export const sendMessageTool = defineTool({
  name: "send_message",
  title: "Send a message",
  description:
    "Message a chat. reply \"wait\" (default): returns the final reply of the turn this message causes (a busy chat runs it as its next turn, no steer), early if that turn asks its user something, or at timeoutSeconds. \"none\": returns at once; steers a busy chat's running turn (PENDING_REQUEST while it awaits its user).",
  chatNote:
    "\"notify\": returns at once; that turn's final reply reaches you later as a message. A \"wait\" cut short goes on as notify (`willNotify`). Never message yourself.",
  externalNote: "On Codex the host runs `/goal …` itself: no turn starts, and outcome \"goal\" carries its answer.",
  input: {
    sessionId: z.string().min(1).describe("From list_sessions."),
    text: z.string().optional(),
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
    ], { text: args.implementPlan ? undefined : args.text }),
  annotations: MUTATING,
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
  const files = args.attachments;
  if (reply === "none") {
    const attachments = files?.length ? await uploadInlineAttachments(ctx.api, summary.id, files) : [];
    return { ...(await dispatchTurn(ctx, summary.id, checked, { input, attachments, interactionMode }, false, timeoutMs)) };
  }
  return dispatchNextTurn(ctx, summary.id, { input, interactionMode }, timeoutMs, files?.length ? () => uploadInlineAttachments(ctx.api, summary.id, files) : undefined);
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
      : provenanceFor(ctx, caller, "sent", text, reply, checked.head.runtimeMode);
  const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, summary.id, args.attachments) : [];
  // Task 6's alias sets `legacyAlias: "thread_send"` exactly for `thread_send {wait: true}` (legacy-aliases.ts).
  const legacyWait = ctx.legacyAlias === "thread_send" && reply === "wait";
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

export type AccountSource = "requested" | "inherited" | "family-default";

export interface ResumeRow { id: string; agent: string; title: string; home: "system" | "account"; accountId?: string }

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
export function launchModel(agent: AgentView, requested: string | undefined, inherited: string | undefined): { slug: string; isLegacy: boolean } {
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
export function launchAccount(agent: AgentView, requested: string | undefined, inherited: string | undefined, resume: ResumeRow | undefined): { accountId?: string; source: AccountSource; note?: string } {
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

/**
 * A `cwd` argument inside the target project: absolute, or relative to the project; an existing
 * directory. Containment is by REAL paths — a symlink inside the project that leads elsewhere (in
 * or out of the sandbox) is refused.
 */
async function cwdInProject(api: ScopeContext["api"], projectPath: string, input: string): Promise<string> {
  const cwd = resolvePath(projectPath, input);
  let real: string;
  try {
    real = await assertInsideFsRoot(api.fsRoot, cwd);
  } catch (error) {
    if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", "cwd is not allowed (outside the sandbox).");
    throw error;
  }
  const root = await realPathInSandbox(api, projectPath);
  const rel = root === null ? null : relativePath(root, real);
  if (rel === null || rel.startsWith("..") || isAbsolute(rel)) throw new ToolError("PERMISSION_DENIED", `cwd "${clipText(input, MAX_ECHO_CHARS)}" is not inside the project the session opens in.`);
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
  profile?: string;
}

/** The daemon's refusals of a launch's Agent Profile (`SessionProfileError` codes through the create route). */
const PROFILE_REFUSALS: ReadonlySet<string> = new Set(["PROFILE_NOT_FOUND", "PROFILE_NOT_READY", "PROFILE_UNSUPPORTED_AGENT"]);

/**
 * `POST /api/sessions` for a tool's create. Every tool launch is unattended (spec 2026-10-18 §5.5):
 * `chat.unattended`, and the profile, when one is named, as `profileId` — a profile that is gone or
 * cannot be prepared fails the call, never Global, and its refusal names the profile.
 */
async function postCreate(api: ScopeContext["api"], body: CreateSessionRequest, profile: { id: string; name: string } | null): Promise<SessionSummary> {
  const launch: CreateSessionRequest = { ...body, ...(profile ? { profileId: profile.id } : {}), chat: { ...body.chat!, unattended: true } };
  try {
    return expectOk<SessionSummary>(await api.request("POST", "/api/sessions", { body: launch }));
  } catch (error) {
    if (profile && error instanceof ToolError && PROFILE_REFUSALS.has(error.code)) {
      throw new ToolError(error.code, `Agent Profile "${profile.name}" could not be used, so no chat was opened: ${error.message} Fix the profile (Agent Profiles in the right rail), pick another, or leave \`profile\` out for Global.`, error.detail);
    }
    throw error;
  }
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

export const createSessionTool = defineTool({
  name: "create_session",
  title: "Open a chat session",
  description:
    "Open an agent chat tab in a project, or resume a conversation (list_conversations). Agents, models, options, modes, accounts: list_agents. With `prompt` it starts at once: reply \"wait\" returns that turn's final reply (or at timeoutSeconds), \"none\" returns at once. The result says the model (isLegacy), mode, account and accountSource (requested, inherited, family-default) and Agent Profile it got. A `profile` that is missing or cannot be prepared fails the call, never Global.",
  chatNote:
    "Defaults: this chat's project, agent, mode (only narrower) and, same agent, model, options, account. `prompt` (self-contained) required unless resuming. reply \"notify\": its final reply reaches you later as a message. `delegate: true`: your task, its final reply the result (reply default \"notify\", else \"none\"). Max 6 unfinished chats you opened, 2 levels deep.",
  externalNote: "`project` is required; runtimeMode defaults to full-access, reply to \"none\".",
  input: {
    project: z.string().min(1).optional().describe("Path or \"workspace/project\"."),
    agent: z.string().min(1).max(64).optional().describe("From list_agents."),
    // min(1): an empty model would read as none, so the default model would launch in its place.
    model: z.string().min(1).max(200).optional(),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.optional(),
    accountId: z.string().min(1).max(200).optional().describe("From list_agents, or \"system\"."),
    title: z.string().trim().min(1).max(300).optional(),
    cwd: z.string().min(1).optional().describe("Inside the project; default: the project."),
    resume: z.object({ conversationId: z.string().min(1) }).optional().describe("From list_conversations."),
    prompt: z.string().trim().min(1).max(CHAT_TEXT_MAX_CHARS).optional(),
    reply: replyField.optional(),
    timeoutSeconds: timeoutSecondsField,
    delegate: z.boolean().optional(),
    profile: z.string().trim().min(1).max(200).optional().describe("Agent Profile id or name (list_agents profiles). Default: Global.")
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
    // Turn policy (a) before any card: a mode broader than this chat's is refused at once — never a card the call could not honour.
    openedThreadRuntimeMode(caller, args.runtimeMode);
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
      // The mode the chat will really get (an unknown caller mode opens the narrowest): what is approved is what runs.
      { label: "Permission mode", value: caller ? openedThreadRuntimeMode(caller, args.runtimeMode) : (args.runtimeMode ?? "full-access") },
      ...(args.accountId ? [{ label: "Account", value: args.accountId }] : []),
      { label: "Agent Profile", value: args.profile ?? "Global" },
      ...(args.cwd ? [{ label: "Working directory", value: args.cwd }] : []),
      ...(args.resume ? [{ label: "Resume", value: args.resume.conversationId }] : []),
      ...(args.prompt !== undefined ? [{ label: "Reply", value: args.reply ?? (args.delegate ? "notify" : "none") }] : [])
    ];
    const sections: ApprovalPreviewSection[] = [{ kind: "fields", title: "Request", rows }];
    if (args.prompt !== undefined) sections.push({ kind: "text", title: "First message", text: args.prompt });
    return { title: `${agentLabel(ctx.caller)} wants to open a chat in ${where}`, scopeLabel: `Project ${where}`, sections };
  },
  annotations: MUTATING,
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
  const profile = args.profile === undefined ? null : await resolveProfileArg(api, args.profile);
  const running = (await listSessions(api, projectPath)).filter((s) => s.status === "running").length;
  if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); close some first.`);
  const chat: CreateAgentChatSessionFields = {
    ...(account.accountId ? { accountId: account.accountId } : {}),
    modelSelection: { model: selection.model, options: selection.options },
    runtimeMode: args.runtimeMode ?? "full-access",
    ...(resume ? { resume: { home: resume.home, conversationId: resume.id } } : {})
  };
  const body: CreateSessionRequest = { kind: "agent-chat", refId, projectPath, cwd, title: args.title ?? (resume?.title || agent.name), ...(account.accountId ? { accountId: account.accountId } : {}), chat };
  const summary = await postCreate(api, body, profile);
  const created = { sessionId: summary.id, accountId: summary.accountId || account.accountId || "system", accountSource: account.source, ...(account.note ? { accountNote: account.note } : {}), ...(model.isLegacy ? { isLegacy: true } : {}), profile };
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
  const current = sameAgent ? (await readThreadHead(api, caller.threadId)).head.modelSelection : undefined;
  const model = launchModel(agent, args.model, current?.model);
  const selection = resolveModelSelection(agent, { model: model.slug, ...(args.options !== undefined ? { options: args.options } : {}), ...(current ? { current } : {}) });
  const account = launchAccount(agent, args.accountId, sameAgent && tab.accountId ? tab.accountId : undefined, resume);
  const ownProject = canonical !== null && canonical.canonical === caller.projectPath;
  const cwd = args.cwd !== undefined ? await cwdInProject(api, projectPath, args.cwd) : ownProject && caller.cwd ? caller.cwd : projectPath;
  const profile = args.profile === undefined ? null : await resolveProfileArg(api, args.profile);
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
  const summary = await postCreate(api, body, profile);
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
    profile,
    relation,
    ...(args.prompt !== undefined && interactionMode === "plan" ? { planMode: true } : {})
  };
  const ref = chatThreadRef(caller, [...sessions, summary], summary, relation);
  if (args.prompt === undefined) return { ...created, ...ref };
  const origin: Exclude<ThreadMessageOrigin, "reply"> = delegate ? "delegated" : "opened";
  const input = provenanceFor(ctx, caller, origin, args.prompt, reply, runtimeMode);
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

/** This family in the catalog (`../catalog/index.ts`). `read_transcript` is the sessions family's (`./sessions.ts`). */
export const messagesFamily: readonly AnyOrquesterTool[] = [createSessionTool, sendMessageTool];
