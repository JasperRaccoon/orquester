import { SYSTEM_ACCOUNT_ID, type AgentAccountsResponse, type RegistryResponse, type SessionSummary } from "@orquester/api";
import { agentChatRoutes, SETTLED_TURN_STATES as TURN_SETTLED_STATES, startedTurns } from "@orquester/api/agent-chat";
import type { AccountHomeKind, AdapterCapabilities, AgentAdapterId, AgentProvidersResponse, ApprovalDecision, ApprovalOption, LatestTurnSummary, ProviderOptionSelection, ProviderRequestKind, RuntimeMode, RuntimeSubagent, ThreadActivityItem, ThreadItem, ThreadSessionStatus, ThreadSnapshotPayload, ThreadTokenUsage, Turn, UserInputQuestion } from "@orquester/api/agent-chat";
import { resolveChatActivity, type ChatActivityRung } from "../agent-chat/activity-ladder.ts";
import { projectNamesFor, type ProjectRef } from "./addressing.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { readThread, requireChatSession } from "./reads.ts";
import { capText } from "./result.ts";

export const VIEW_TEXT_CAP = 16_384;
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
  pending: { approvals: PendingApprovalView[]; questions: PendingQuestionView[] }; plan?: PlanView; subagents: SubagentView[]; lastReply?: { turnId: string; text: string; truncated: boolean; completedAt: string | null } }
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
  const providers = await api.request("GET", agentChatRoutes.providers);
  if (providers.status < 400) {
    for (const provider of (providers.body as AgentProvidersResponse).providers ?? []) capabilitiesByAdapter.set(provider.id, provider.capabilities);
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
      decisions: (a.options ?? DEFAULT_APPROVAL_DECISIONS).map((o) => ({ decision: o.decision, label: o.label, ...(o.warning ? { warning: o.warning } : {}) }))
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

export function planView(snap: ThreadSnapshotPayload, s: SessionSummary): PlanView | null {
  for (let i = snap.items.length - 1; i >= 0; i -= 1) {
    const item = snap.items[i]!;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") {
      const p = (item.payload ?? {}) as { planId?: unknown; planMarkdown?: unknown; truncated?: unknown };
      const md = capText(typeof p.planMarkdown === "string" ? p.planMarkdown : "", VIEW_TEXT_CAP);
      // The snapshot is slimmed on the wire (§5.6): a plan over 16 KiB of UTF-8 arrives already cut, `truncated` on its payload.
      return { planId: typeof p.planId === "string" ? p.planId : item.id, markdown: md.text, truncated: md.truncated || p.truncated === true, actionable: s.hasActionableProposedPlan === true };
    }
  }
  return null;
}

export function subagentView(r: RuntimeSubagent): SubagentView {
  const v: SubagentView = { id: r.id, kind: r.kind, agentKind: r.agentKind, title: r.title ?? null, status: r.status, startedAt: r.startedAt ?? null, completedAt: r.completedAt ?? null };
  if (r.model) v.model = r.model;
  if (r.effort) v.effort = r.effort;
  if (r.progress) v.progress = typeof r.progress === "string" ? r.progress : JSON.stringify(r.progress);
  if (r.lastToolName) v.lastToolName = r.lastToolName;
  if (r.error) v.error = typeof r.error === "string" ? r.error : JSON.stringify(r.error);
  return v;
}

export function latestSettledTurn(turns: readonly Turn[]): Turn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.turnId && SETTLED_TURN_STATES.has(t.state)) return t;
  }
  return null;
}

export function assistantTextForTurn(items: readonly ThreadItem[], turnId: string): string {
  return items.filter((i): i is Extract<ThreadItem, { kind: "message" }> => i.kind === "message" && i.role === "assistant" && i.turnId === turnId && !i.agentId).map((i) => i.text).filter(Boolean).join("\n\n");
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
    if (typeof u.maxTokens === "number" && u.maxTokens > 0) { cw.maxTokens = u.maxTokens; cw.percentUsed = Math.round((u.usedTokens / u.maxTokens) * 100); }
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
    // An absent `supportsConversationRollback` means true (AdapterCapabilities), as the GUI reads it.
    supports: { planMode: caps?.showPlanModeToggle ?? false, rollback: caps !== undefined && caps.supportsConversationRollback !== false, compaction: caps?.compaction !== undefined, backgroundTasks: caps?.supportsBackgroundTasks ?? false }
  };
  const label = head.accountId ? ctx.accountLabelById.get(head.accountId) : "System";
  if (label) chat.accountLabel = label;
  if (head.session.lastError) chat.lastError = head.session.lastError;
  const cw = latestContextWindow(snap.items);
  if (cw) chat.contextWindow = cw;
  const detail: SessionDetail = { ...base, chat, pending: { approvals: pendingApprovalViews(snap), questions: pendingQuestionViews(snap) }, subagents: snap.roster.map(subagentView) };
  const plan = planView(snap, s);
  if (plan) detail.plan = plan;
  const reply = lastReply(snap);
  if (reply) detail.lastReply = reply;
  return detail;
}
