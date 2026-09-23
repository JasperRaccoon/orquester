import { SYSTEM_ACCOUNT_ID, type AgentAccountsResponse, type RegistryResponse, type SessionSummary } from "@orquester/api";
import { agentChatRoutes, SETTLED_TURN_STATES as TURN_SETTLED_STATES, startedTurns } from "@orquester/api/agent-chat";
import type { AccountHomeKind, AdapterCapabilities, AgentAdapterId, ApprovalDecision, ApprovalOption, LatestTurnSummary, ProviderOptionSelection, ProviderRequestKind, RuntimeMode, RuntimeSubagent, ThreadActivityItem, ThreadItem, ThreadSessionStatus, ThreadSnapshotPayload, ThreadTokenUsage, Turn, UserInputQuestion } from "@orquester/api/agent-chat";
import { resolveChatActivity, type ChatActivityRung } from "../agent-chat/activity-ladder.ts";
import { projectNamesFor, type ProjectRef } from "./addressing.ts";
import { providerRows, supportsFrom } from "./agents.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { readThread, requireChatSession } from "./reads.ts";
import { capText, clipText, MAX_RESULT_BYTES, resultBytes } from "./result.ts";
import { cutTail, fitRoster, proposedPlan, sized, SUBAGENT_TEXT_CHARS } from "./transcript.ts";

export const VIEW_TEXT_CAP = 16_384;
/**
 * The most a session detail takes, in UTF-8 bytes of its JSON: ok()'s cap less room for what a tool returns beside it
 * (`seq`, `applied`, …, well under 1 KB). send_message and implement_plan, which add `pending`, fit the detail again in
 * what their own fields leave (`fitDetail`, tools/messages.ts).
 */
export const SESSION_DETAIL_BYTES = MAX_RESULT_BYTES - 1_000;
/** completed | failed | interrupted | cancelled — the fold's own set (`thread.ts`), typed for callers holding a plain string. */
export const SETTLED_TURN_STATES: ReadonlySet<string> = TURN_SETTLED_STATES;
/** §4.3's default four with the GUI's labels (`banner-model.ts` `DEFAULT_APPROVAL_OPTIONS`), listed approve-first as spec §6.2 does. */
export const DEFAULT_APPROVAL_DECISIONS: readonly ApprovalOption[] = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" }
];

export type SessionReason = ChatActivityRung | "new" | "exited";
export interface SessionView { id: string; kind: "chat" | "terminal"; agent: string; adapter?: AgentAdapterId; title: string; project: ProjectRef; cwd: string; createdAt: string; order: number;
  status: "working" | "waiting" | "idle"; attention: "needs-input" | "finished" | "bell" | null; needsAttentionAt: string | null; reason: SessionReason | null;
  chat?: { sessionStatus: ThreadSessionStatus; accountId: string; latestTurn: LatestTurnSummary | null; pending: { approvals: boolean; questions: boolean }; planReady: boolean; backgroundLiveness: "working" | "monitoring" | null };
  terminal?: { status: "running" | "exited"; exitCode?: number; legacyAgent?: boolean } }
export interface PendingApprovalView { requestId: string; kind: ProviderRequestKind; createdAt: string; detail?: string; appName?: string; tool?: { name: string; input: unknown }; decisions: { decision: ApprovalDecision; label: string; warning?: string }[] }
export interface PendingQuestionView { requestId: string; createdAt: string; turnId?: string; responseMode: "blocking" | "message"; dismissible: boolean;
  questions: { index: number; id: string; header: string; question: string; options: { label: string; description: string; value?: string }[]; multiSelect: boolean; allowCustomAnswer: boolean; isSecret?: boolean; isOther?: boolean }[] }
export interface SubagentView { id: string; kind: string; agentKind: "agent" | "background"; title: string | null; status: string; model?: string; effort?: string; progress?: string; lastToolName?: string; startedAt: string | null; completedAt: string | null; error?: string }
export interface PlanView { planId: string; markdown: string; truncated: boolean; actionable: boolean }
export interface SessionDetail extends SessionView { chat: SessionView["chat"] & { model: string; options: Record<string, string | boolean>; runtimeMode: RuntimeMode; home: AccountHomeKind; accountLabel?: string; activeTurnId: string | null; turnCount: number; lastError?: string; continueAfterRestart: boolean;
    contextWindow?: { usedTokens: number; maxTokens?: number; percentUsed?: number; compactsAutomatically?: boolean }; supports: { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean } };
  pending: { approvals: PendingApprovalView[]; questions: PendingQuestionView[] }; plan?: PlanView; subagents: SubagentView[]; subagentsTruncated?: true; lastReply?: { turnId: string; text: string; truncated: boolean; completedAt: string | null } }
export interface ViewContext { workspacesDir: string; adapterByRefId: ReadonlyMap<string, AgentAdapterId>; accountLabelById: ReadonlyMap<string, string>; capabilitiesByAdapter: ReadonlyMap<string, AdapterCapabilities> }

export async function buildViewContext(api: DaemonApi): Promise<ViewContext> {
  const adapterByRefId = new Map<string, AgentAdapterId>();
  const accountLabelById = new Map<string, string>();
  const capabilitiesByAdapter = new Map<string, AdapterCapabilities>();
  const registry = await api.request("GET", "/api/registry");
  if (registry.status < 400) {
    for (const entry of (registry.body as RegistryResponse).agents ?? []) if (entry.chat?.adapter) adapterByRefId.set(entry.id, entry.chat.adapter);
  }
  const accounts = await api.request("GET", "/api/agent-accounts");
  if (accounts.status < 400) {
    for (const account of (accounts.body as AgentAccountsResponse).accounts ?? []) accountLabelById.set(account.id, account.label);
  }
  // The host's body, read field-wise by list_agents' own reader: an older host's degraded row reads as "no capabilities"
  // (supportsFrom answers false), never as a throw out of get_session, send_message or create_session.
  const providers = await api.request("GET", agentChatRoutes.providers);
  if (providers.status < 400) {
    for (const [id, row] of providerRows(providers.body)) if (row.capabilities) capabilitiesByAdapter.set(id, row.capabilities);
  }
  return { workspacesDir: api.workspacesDir, adapterByRefId, accountLabelById, capabilitiesByAdapter };
}

export function sessionReason(s: SessionSummary): SessionReason | null {
  if (s.kind !== "agent-chat") return s.status === "exited" ? "exited" : null;
  if ((s.chatSessionStatus ?? "idle") === "idle" && !s.latestTurn) return "new";
  const rung = resolveChatActivity(s).rung;
  return rung === "unknown" ? null : rung;
}

export function sessionView(s: SessionSummary, ctx: ViewContext): SessionView {
  const isChat = s.kind === "agent-chat";
  const view: SessionView = {
    id: s.id, kind: isChat ? "chat" : "terminal", agent: s.refId, title: s.title,
    project: projectNamesFor(s.projectPath, ctx.workspacesDir), cwd: s.cwd, createdAt: s.createdAt, order: s.order,
    status: s.activity?.state ?? "idle", attention: s.activity?.attention ?? null, needsAttentionAt: s.activity?.needsAttentionAt ?? null,
    reason: sessionReason(s)
  };
  if (isChat) {
    const adapter = ctx.adapterByRefId.get(s.refId);
    if (adapter) view.adapter = adapter;
    view.chat = {
      sessionStatus: s.chatSessionStatus ?? "idle", accountId: s.accountId ?? SYSTEM_ACCOUNT_ID, latestTurn: s.latestTurn ?? null,
      pending: { approvals: s.hasPendingApprovals === true, questions: s.hasPendingUserInput === true },
      planReady: s.hasActionableProposedPlan === true, backgroundLiveness: s.backgroundLiveness ?? null
    };
  } else {
    view.terminal = { status: s.status };
    if (s.exitCode !== undefined) view.terminal.exitCode = s.exitCode;
    if (s.kind === "agent") view.terminal.legacyAgent = true;
  }
  return view;
}

export function optionsObject(options: readonly ProviderOptionSelection[] | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const o of options ?? []) out[o.id] = o.value;
  return out;
}

function rawRequestActivity(items: readonly ThreadItem[], activityKind: string, requestId: string): ThreadActivityItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "activity" && item.activityKind === activityKind && (item.payload as { requestId?: unknown } | null)?.requestId === requestId) return item;
  }
  return undefined;
}

function boundedJson(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value ?? null);
  return text.length <= maxChars ? value : capText(text, maxChars).text;
}

export function pendingApprovalViews(snap: ThreadSnapshotPayload): PendingApprovalView[] {
  return snap.pending.approvals.map((a) => {
    const raw = rawRequestActivity(snap.items, "approval.requested", a.requestId);
    const args = (raw?.payload as { args?: { toolName?: unknown; input?: unknown } } | undefined)?.args;
    const view: PendingApprovalView = {
      requestId: a.requestId, kind: a.requestKind, createdAt: a.createdAt,
      decisions: (a.options?.length ? a.options : DEFAULT_APPROVAL_DECISIONS).map((o) => ({ decision: o.decision, label: o.label, ...(o.warning ? { warning: o.warning } : {}) }))
    };
    if (a.detail) view.detail = capText(a.detail, 4096).text;
    if (a.appName) view.appName = a.appName;
    if (args && typeof args === "object" && typeof args.toolName === "string") view.tool = { name: args.toolName, input: boundedJson(args.input, 4096) };
    return view;
  });
}

export function pendingQuestionViews(snap: ThreadSnapshotPayload): PendingQuestionView[] {
  return snap.pending.userInputs.map((q) => {
    const raw = rawRequestActivity(snap.items, "user-input.requested", q.requestId);
    const rawQuestions = (raw?.payload as { questions?: UserInputQuestion[] } | undefined)?.questions ?? [];
    const view: PendingQuestionView = {
      requestId: q.requestId, createdAt: q.createdAt, responseMode: q.responseMode === "message" ? "message" : "blocking", dismissible: q.dismissible,
      questions: q.questions.map((question, i) => {
        const rq = rawQuestions.find((r) => r.id === question.id) ?? rawQuestions[i];
        const qv: PendingQuestionView["questions"][number] = {
          index: i + 1, id: question.id, header: question.header, question: question.question,
          options: question.options.map((o) => ({ label: o.label, description: o.description, ...(o.value !== undefined ? { value: o.value } : {}) })),
          multiSelect: question.multiSelect === true, allowCustomAnswer: question.allowCustomAnswer !== false
        };
        if (rq?.isSecret) qv.isSecret = true;
        if (rq?.isOther) qv.isOther = true;
        return qv;
      })
    };
    if (q.turnId) view.turnId = q.turnId;
    return view;
  });
}

/**
 * The latest proposed plan. `actionable` is judged on the snapshot with the host's rule (`proposedPlan`, transcript.ts),
 * never on the summary's flag, which trails it by one poll: right after implement_plan that flag still says yes.
 */
export function planView(snap: ThreadSnapshotPayload): PlanView | null {
  const plan = proposedPlan(snap.items);
  if (!plan) return null;
  const p = (plan.item.payload ?? {}) as { planId?: unknown; planMarkdown?: unknown; truncated?: unknown };
  const md = capText(typeof p.planMarkdown === "string" ? p.planMarkdown : "", VIEW_TEXT_CAP);
  // The snapshot is slimmed on the wire (§5.6): a plan over 16 KiB of UTF-8 arrives already cut, `truncated` on its payload.
  return { planId: typeof p.planId === "string" ? p.planId : plan.item.id, markdown: md.text, truncated: md.truncated || p.truncated === true, actionable: plan.actionable };
}

/** A subagent's text as a view shows it: at most SUBAGENT_TEXT_CHARS code points, a cut ending in "…"; a non-string as its JSON. */
const subagentText = (value: unknown): string => clipText(typeof value === "string" ? value : JSON.stringify(value), SUBAGENT_TEXT_CHARS);

export function subagentView(r: RuntimeSubagent): SubagentView {
  const v: SubagentView = { id: r.id, kind: r.kind, agentKind: r.agentKind, title: r.title == null ? null : subagentText(r.title), status: r.status, startedAt: r.startedAt ?? null, completedAt: r.completedAt ?? null };
  if (r.model) v.model = r.model;
  if (r.effort) v.effort = r.effort;
  if (r.progress) v.progress = subagentText(r.progress);
  if (r.lastToolName) v.lastToolName = r.lastToolName;
  if (r.error) v.error = subagentText(r.error);
  return v;
}

/**
 * `text` cut from its end, on a code-point boundary, until its JSON — with its `truncated` flag turning true, which
 * saves a byte of its own ("false" → "true") — is at least `need` bytes smaller; null when there is nothing to cut.
 * A text is never marked cut that was not.
 */
function cutText(text: string, truncated: boolean, need: number): { text: string; saved: number } | null {
  const flip = truncated ? 0 : 1;
  const cut = cutTail(text, Math.max(1, need - flip));
  return cut.head.length < text.length ? { text: cut.head, saved: cut.saved + flip } : null;
}

/**
 * `detail` within `budget` bytes of JSON. First its subagent list: settled rows go first, then live ones, each first
 * seen first — read_transcript's rule (`fitRoster`, transcript.ts) — and `subagentsTruncated` says so. Then, when the
 * detail is still over (a plan and a reply of 16 384 wide characters can pass the cap on their own), the last reply's
 * text and after it the plan's markdown are cut by bytes from their end, on a code-point boundary, each marked
 * `truncated`. It stops as soon as the detail fits, and every other field stays whole: a detail whose requests alone
 * pass the budget still does (ok()'s last resort then cuts it). Pure, and linear: each row is measured once, the rest
 * of the detail at most twice, and a text is walked once, over the tail it loses.
 */
export function fitDetail(detail: SessionDetail, budget: number): SessionDetail {
  const rows = sized(detail.subagents);
  let fitted = detail;
  let frame = resultBytes({ ...detail, subagents: [] });
  let listed = fitRoster(rows, budget - frame);
  if (listed.trimmed) {
    frame = resultBytes({ ...detail, subagents: [], subagentsTruncated: true });
    listed = fitRoster(rows, budget - frame);
    fitted = { ...detail, subagents: listed.rows, subagentsTruncated: true };
  }
  let over = frame + listed.bytes - budget;
  if (over > 0 && fitted.lastReply) {
    const cut = cutText(fitted.lastReply.text, fitted.lastReply.truncated, over);
    if (cut) {
      fitted = { ...fitted, lastReply: { ...fitted.lastReply, text: cut.text, truncated: true } };
      over -= cut.saved;
    }
  }
  if (over > 0 && fitted.plan) {
    const cut = cutText(fitted.plan.markdown, fitted.plan.truncated, over);
    if (cut) fitted = { ...fitted, plan: { ...fitted.plan, markdown: cut.text, truncated: true } };
  }
  return fitted;
}

export function latestSettledTurn(turns: readonly Turn[]): Turn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.turnId && SETTLED_TURN_STATES.has(t.state)) return t;
  }
  return null;
}

/**
 * The main agent's answer in a turn: its assistant messages, joined. A message the provider marked as commentary
 * (Codex's `phase`, carried as `messageKind`) is the running "I'll do X next" narration, not the answer — the GUI
 * demotes it into the activity group (`isDemotedAssistantMessage`), and it is left out here too.
 */
export function assistantTextForTurn(items: readonly ThreadItem[], turnId: string): string {
  return items.filter((i): i is Extract<ThreadItem, { kind: "message" }> => i.kind === "message" && i.role === "assistant" && i.turnId === turnId && !i.agentId && i.messageKind !== "commentary").map((i) => i.text).filter(Boolean).join("\n\n");
}

export function lastReply(snap: ThreadSnapshotPayload): SessionDetail["lastReply"] | null {
  const t = latestSettledTurn(snap.turns);
  if (!t?.turnId) return null;
  const capped = capText(assistantTextForTurn(snap.items, t.turnId), VIEW_TEXT_CAP);
  return { turnId: t.turnId, text: capped.text, truncated: capped.truncated, completedAt: t.completedAt };
}

function latestContextWindow(items: readonly ThreadItem[]): SessionDetail["chat"]["contextWindow"] | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind !== "activity" || item.activityKind !== "context-window.updated") continue;
    const u = (item.payload ?? {}) as Partial<Record<keyof ThreadTokenUsage, unknown>>;
    // A row without a usable reading reaches the snapshot on purpose and every reader walks past it, as the GUI's
    // meter does (`isResolvableContextWindowActivity`, agent-host/ingestion/coalesce.ts).
    if (typeof u.usedTokens !== "number" || !Number.isFinite(u.usedTokens) || u.usedTokens < 0) continue;
    const cw: NonNullable<SessionDetail["chat"]["contextWindow"]> = { usedTokens: u.usedTokens };
    // A reading can run past its window (a compaction lagging the turn); the percentage stops at 100 like the GUI's ring,
    // and the raw counts stay as reported.
    if (typeof u.maxTokens === "number" && u.maxTokens > 0) { cw.maxTokens = u.maxTokens; cw.percentUsed = Math.min(100, Math.round((u.usedTokens / u.maxTokens) * 100)); }
    if (typeof u.compactsAutomatically === "boolean") cw.compactsAutomatically = u.compactsAutomatically;
    return cw;
  }
  return undefined;
}

/** The full detail of a chat session: the summary, its thread snapshot and the catalogue context. */
export async function chatDetail(api: DaemonApi, sessionId: string): Promise<SessionDetail> {
  const summary = await requireChatSession(api, sessionId);
  const [snap, ctx] = await Promise.all([readThread(api, sessionId), buildViewContext(api)]);
  return sessionDetail(summary, snap, ctx);
}

export function sessionDetail(s: SessionSummary, snap: ThreadSnapshotPayload, ctx: ViewContext): SessionDetail {
  const base = sessionView(s, ctx);
  const head = snap.head;
  const caps = ctx.capabilitiesByAdapter.get(head.adapter);
  const chat: SessionDetail["chat"] = {
    ...(base.chat as NonNullable<SessionView["chat"]>),
    model: head.modelSelection.model, options: optionsObject(head.modelSelection.options), runtimeMode: head.runtimeMode, home: head.home,
    // Turns are numbered by START ORDER (turns.ts), never by the sparse checkpoint list — this is the number revert_session/get_turn_diff speak in.
    activeTurnId: head.session.activeTurnId, turnCount: startedTurns(snap.turns).length, continueAfterRestart: head.continueAfterRestart !== undefined,
    supports: supportsFrom(caps)
  };
  const label = head.accountId ? ctx.accountLabelById.get(head.accountId) : "System";
  if (label) chat.accountLabel = label;
  if (head.session.lastError) chat.lastError = head.session.lastError;
  const cw = latestContextWindow(snap.items);
  if (cw) chat.contextWindow = cw;
  const detail: SessionDetail = { ...base, chat, pending: { approvals: pendingApprovalViews(snap), questions: pendingQuestionViews(snap) }, subagents: snap.roster.map(subagentView) };
  const plan = planView(snap);
  if (plan) detail.plan = plan;
  const reply = lastReply(snap);
  if (reply) detail.lastReply = reply;
  return fitDetail(detail, SESSION_DETAIL_BYTES);
}
