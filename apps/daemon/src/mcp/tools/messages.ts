import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { agentChatRoutes, buildPlanImplementationPrompt, isPlanImplementationMessage, MAX_TURN_INPUT_CHARS, type AttachmentRef, type ThreadActivityItem, type ThreadItemResponse, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { supportsFrom } from "../agents.ts";
import { attachmentInputSchema, MAX_ATTACHMENTS, uploadInlineAttachments } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { expectOk, ToolError } from "../errors.ts";
import { readThread, requireChatSession, sendCommand } from "../reads.ts";
import { defineTool, MUTATING, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { transcriptEntries, type TranscriptResult } from "../transcript.ts";
import { buildViewContext, chatDetail, SETTLED_TURN_STATES, type SessionDetail } from "../views.ts";
import { turnBaseline, waitForTurn, type TurnBaseline, type TurnOutcome } from "../wait.ts";

const MAX_WAIT_MS = 600_000;
/** read_transcript's ceiling: the budget covers the whole result in UTF-8 bytes (transcript.ts), 5 000 under ok()'s 60 000-byte cap (result.ts). */
const MAX_TRANSCRIPT_CHARS = 55_000;
/**
 * How long a needs-input the snapshot contradicts waits for the summary to move before looking again anyway: just
 * past one host poll (`SUMMARY_POLL_INTERVAL_MS`, 1.5 s, agent-chat/summary.ts). The session's next bus event
 * normally ends the wait first.
 */
const STALE_RECHECK_MS = 2_000;
const TRUNCATED_HINT = "Shed to fit maxChars: reasoning, then tool detail, then the oldest rows (coveredTurns says which turns are left). Raise maxChars (max 55000), include less, or use get_turn_diff for one turn's file changes.";
const SUBAGENTS_TRIMMED_HINT = "The subagent list was trimmed too — full roster: get_session.";

/**
 * The hint a shed read_transcript result carries, or none for a whole one. It keys on `truncated`, which transcript.ts
 * sets on every result it sheds, a trimmed subagent list alone included; `subagentsTruncated` is present only when the
 * list was trimmed. A shed result stays TRANSCRIPT_HINT_BYTES under `maxChars` for this field, so the answer, hint
 * included, keeps within `maxChars`.
 */
export function transcriptHint(result: Pick<TranscriptResult, "truncated" | "subagentsTruncated">): string | undefined {
  if (!result.truncated) return undefined;
  return result.subagentsTruncated ? `${TRUNCATED_HINT} ${SUBAGENTS_TRIMMED_HINT}` : TRUNCATED_HINT;
}

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
const waitFields = {
  wait: z.boolean().default(true).describe("Block until the turn settles or the agent asks something (default true)."),
  timeoutMs: z.number().int().min(1_000).max(MAX_WAIT_MS).default(120_000).describe("How long to wait, in ms (max 600000). On timeout the turn keeps running.")
};

/** The send preconditions the GUI applies (spec §7.4), and the snapshot they were checked on. */
async function readyToSend(api: DaemonApi, summary: SessionSummary): Promise<ThreadSnapshotPayload> {
  if (summary.chatSessionStatus === "error") throw new ToolError("SESSION_BUSY", "This session's agent is in an error state. Call stop_session first, then send again.");
  const snap = await readThread(api, summary.id);
  const { approvals, userInputs } = snap.pending;
  if (approvals.length || userInputs.length) {
    const open = [
      ...approvals.map((a) => `approval ${a.requestId} (resolve_approval)`),
      ...userInputs.map((q) => `question ${q.requestId} (answer_question${q.dismissible ? " or dismiss_question" : ""})`)
    ];
    throw new ToolError("PENDING_REQUEST", `Answer the agent first: it is waiting on ${open.join(" and ")}. get_session shows the details.`, { approvals: approvals.map((a) => a.requestId), questions: userInputs.map((q) => q.requestId) });
  }
  return snap;
}

type TurnBody = { input: string; attachments?: AttachmentRef[]; interactionMode: "default" | "plan" };
type SendResult = { seq: number; outcome: TurnOutcome | "sent"; turnId?: string; reply?: string; replyTruncated?: boolean; pending?: SessionDetail["pending"]; session: SessionDetail };

/**
 * Post the turn (§7.4) and, with `wait`, block per §9.1; the result is read from the fresh snapshot. `checked` is the
 * snapshot the send was checked on. The baseline is the summary read right before the POST: the checks, the catalogue
 * read and the uploads take time, and a turn that ended meanwhile must not read as this message's outcome.
 */
async function dispatchTurn(ctx: ToolContext, sessionId: string, checked: ThreadSnapshotPayload, body: TurnBody, wait: boolean, timeoutMs: number): Promise<SendResult> {
  const summary = await requireChatSession(ctx.api, sessionId);
  const baseline = turnBaseline(summary);
  const over = turnsOverBefore(checked, summary);
  const { seq } = await sendCommand(ctx.api, sessionId, "turn", { input: body.input, ...(body.attachments?.length ? { attachments: body.attachments } : {}), interactionMode: body.interactionMode });
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
 * the summary trails the host by up to one poll, so right after answer_question it can still flag the request just
 * settled. The wait then goes on until a real outcome or the timeout — resuming on the session's next bus event (or
 * after STALE_RECHECK_MS), never looping on the stale summary. For the same lag, a verdict on a turn that was already
 * `over` when the message was posted is the list catching up, not this message's outcome: the wait rebases on it and
 * goes on. A session in error is a real failure whatever its latest turn.
 */
async function awaitTurn(ctx: ToolContext, sessionId: string, baseline: TurnBaseline, over: ReadonlySet<string>, timeoutMs: number): Promise<{ outcome: TurnOutcome; session: SessionDetail }> {
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
  const head: Omit<SendResult, "session"> = { seq, outcome };
  const reply = session.lastReply;
  const settled = outcome !== "sent" && outcome !== "needs-input" && outcome !== "timeout";
  if (settled && reply && ours(reply.turnId)) {
    head.turnId = reply.turnId;
    head.reply = reply.text;
    if (reply.truncated) head.replyTruncated = true;
  } else if (ours(session.chat.activeTurnId)) {
    head.turnId = session.chat.activeTurnId;
  }
  if (session.pending.approvals.length || session.pending.questions.length) head.pending = session.pending;
  if (head.reply === undefined) return { ...head, session };
  // `reply` IS the detail's lastReply: returned once, which keeps a long reply inside the result cap.
  const { lastReply: _returnedAsReply, ...rest } = session;
  return { ...head, session: rest };
}

const sendMessage = defineTool({
  name: "send_message",
  title: "Send a message",
  description: "Send a message to a chat session (with optional image/file attachments, optionally in plan mode). With wait:true (default) it returns the agent's reply, or the question/approval it stopped on. While a turn is running the message steers it.",
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
    const checked = await readyToSend(ctx.api, summary);
    if (args.planMode) {
      const view = await buildViewContext(ctx.api);
      const adapter = view.adapterByRefId.get(summary.refId);
      const caps = adapter ? view.capabilitiesByAdapter.get(adapter) : undefined;
      // The gate get_session reports as supports.planMode: capabilities that could not be read are no plan mode.
      if (!supportsFrom(caps).planMode) {
        throw new ToolError("INVALID_ARGUMENT", caps
          ? `${summary.refId} has no plan mode toggle${adapter === "opencode" ? ' — use update_session {options:{agent:"plan"}}' : ""}.`
          : `Plan mode can't be confirmed for ${summary.refId} right now: its capabilities could not be read. Retry shortly, or send without planMode.`);
      }
    }
    const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, args.sessionId, args.attachments) : [];
    return dispatchTurn(ctx, args.sessionId, checked, { input: text, attachments, interactionMode: args.planMode ? "plan" : "default" }, args.wait, args.timeoutMs);
  }
});

/**
 * The plan the GUI's Implement button sends: the LATEST proposed plan, unless a later user message already
 * implemented it. That is the host's own `hasActionableProposedPlan` rule, judged on the snapshot just read rather
 * than on the summary flag, which trails the host by up to one poll: a second call in that window would send the
 * plan twice. A plan over the 16 KiB wire cap arrives slimmed (`payload.truncated`) and is read back whole — the
 * agent must never implement a cut plan.
 */
async function actionablePlanMarkdown(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload): Promise<string> {
  let plan: ThreadActivityItem | undefined;
  for (let i = snap.items.length - 1; i >= 0 && !plan; i -= 1) {
    const item = snap.items[i]!;
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) {
      throw new ToolError("INVALID_ARGUMENT", "The latest proposed plan was already sent for implementation; follow up with send_message.");
    }
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") plan = item;
  }
  if (!plan) throw new ToolError("INVALID_ARGUMENT", "This session has no proposed plan to implement (get_session.plan); ask for one with send_message {planMode:true}.");
  let payload = (plan.payload ?? {}) as { planMarkdown?: unknown; truncated?: unknown };
  if (payload.truncated === true) {
    const { item } = expectOk<ThreadItemResponse>(await api.request("GET", agentChatRoutes.item(sessionId, plan.id)), "plan");
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

const readTranscript = defineTool({
  name: "read_transcript",
  title: "Read the transcript",
  // A list cut to fit ends in one element of its own shape counting the rest (transcript.ts `cutRow`): a changedFiles
  // "…N more files" string, a files row {path: "…N more files", additions, deletions} with the rest's line totals, an
  // attachments row {name: "…N more attachments", type: "omitted"}. The description has to say so: it reads as data.
  description: "What was said and done in a session, newest turns last: messages, tool calls, approvals, questions, plans, file changes, errors. `agentId` drills into one subagent's own timeline. A list cut to fit (a checkpoint's files, a tool's changedFiles, a message's attachments) ends in a marker counting the rest (\"…12 more files\"; a files marker carries their real line totals), not a real entry.",
  input: {
    sessionId: sessionIdField,
    turns: z.number().int().min(1).max(200).default(3).describe("How many of the latest turns to include."),
    agentId: z.string().optional().describe("A subagent id from get_session.subagents to read its own timeline."),
    include: z.array(z.enum(["reasoning", "tools", "activity"])).default(["tools", "activity"]).describe("Extra row kinds; reasoning is opt-in."),
    maxChars: z.number().int().min(2_000).max(MAX_TRANSCRIPT_CHARS).default(40_000).describe("Size budget for the result, in UTF-8 bytes (max 55000; every tool result is capped at 60000 bytes). Over it, the transcript sheds reasoning, then tool detail, then its oldest rows, and cuts the latest reply last; the subagent list keeps at least a quarter when it needs it, plus whatever the transcript leaves unused.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    if (args.agentId && !snap.roster.some((r) => r.id === args.agentId) && !snap.items.some((i) => i.agentId === args.agentId)) {
      throw new ToolError("INVALID_ARGUMENT", `No subagent "${args.agentId}". Known: ${snap.roster.map((r) => r.id).join(", ") || "none"}.`);
    }
    const result = transcriptEntries(snap, { turns: args.turns, ...(args.agentId ? { agentId: args.agentId } : {}), include: new Set(args.include), maxChars: args.maxChars });
    const hint = transcriptHint(result);
    return hint ? { ...result, hint } : { ...result };
  }
});

export const messageTools: ToolDef[] = [sendMessage, implementPlan, readTranscript] as ToolDef[];
