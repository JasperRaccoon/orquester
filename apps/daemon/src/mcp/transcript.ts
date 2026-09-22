import { isPlanImplementationMessage, startedTurns, type RuntimeSubagent, type ThreadActivityItem, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { capText } from "./result.ts";

export type TranscriptInclude = "reasoning" | "tools" | "activity";
export interface TranscriptEntry { turn: number | null; turnId: string | null; kind: "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "subagent" | "plan" | "changes" | "compaction" | "error" | "warning" | "info"; createdAt: string; agentId?: string; text?: string;
  attachments?: { name: string; type: string }[]; tool?: { type: string; title: string; status: string; command?: string; detail?: string; changedFiles?: string[] }; requestId?: string; requestKind?: string; decision?: string;
  questions?: string[]; answered?: boolean; subagent?: { id: string; title: string | null; status: string }; actionable?: boolean; files?: { path: string; additions: number; deletions: number }[]; state?: string; beforeTokens?: number; afterTokens?: number }
export interface TranscriptOptions { turns: number; agentId?: string; include: ReadonlySet<TranscriptInclude>; maxChars: number }
export interface TranscriptResult { entries: TranscriptEntry[]; turnCount: number; coveredTurns: [number, number] | null; truncated: boolean; subagents: { id: string; title: string | null; status: string }[] }

const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);
const SKIPPED_ACTIVITY = new Set(["tool.output", "tool.progress", "turn.proposed.delta", "turn.plan.updated", "hook.started", "hook.progress", "hook.completed", "context-window.updated", "checkpoint.captured", "background.requested", "task.progress", "task.updated"]);

/** A tool's `detail` after the second shed: at most this many characters, the cut marked by the trailing "…". */
const SHED_DETAIL_CHARS = 200;

type P = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const shedDetail = (e: TranscriptEntry): void => {
  if (e.tool?.detail && capText(e.tool.detail, SHED_DETAIL_CHARS).truncated) e.tool.detail = `${capText(e.tool.detail, SHED_DETAIL_CHARS - 1).text}…`;
};
/** Label plus detail, as the GUI's row shows them; runtime.error and runtime.warning keep their text in `message`. */
const rowText = (a: ThreadActivityItem, p: P): string => {
  const detail = str(p.detail) ?? (str(p.message) !== a.summary ? str(p.message) : undefined);
  return detail ? `${a.summary}: ${detail}` : a.summary;
};
const rosterView = (r: RuntimeSubagent): NonNullable<TranscriptEntry["subagent"]> => ({ id: r.id, title: r.title ?? null, status: r.status });

/** The host's `hasActionableProposedPlan` rule: the LATEST proposed plan, until a later user message implements it. */
function actionablePlanId(items: readonly ThreadItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) return null;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") return item.id;
  }
  return null;
}

export function transcriptEntries(snap: ThreadSnapshotPayload, opts: TranscriptOptions): TranscriptResult {
  // 1. Turn numbering: the ordinal among STARTED turns (turns.ts), the same number
  //    revert_session and get_turn_diff speak in; the highest is turnCount.
  const ordered = startedTurns(snap.turns);
  const turnIndex = new Map<string, number>();
  ordered.forEach((t, i) => turnIndex.set(t.turnId, i + 1));
  const turnCount = ordered.length;
  const wanted = Math.max(1, Math.floor(opts.turns));
  let from = Math.max(1, turnCount - wanted + 1);
  const roster = new Map(snap.roster.map((r) => [r.id, r]));
  const actionablePlan = actionablePlanId(snap.items);
  const build = (fromTurn: number): TranscriptEntry[] => {
    const selected = new Set(ordered.slice(fromTurn - 1).map((t) => t.turnId as string));
    const earliest = ordered[fromTurn - 1]?.requestedAt ?? "";
    // A task row anchors its agent in the parent view even when it carries an agentId: Codex, OpenCode
    // and Grok stamp the task's own id on it.
    const isAnchor = (item: ThreadItem): boolean => item.kind === "activity" && item.activityKind.startsWith("task.");
    const inScope = (item: ThreadItem): boolean => (opts.agentId ? item.agentId === opts.agentId : !item.agentId || isAnchor(item));
    const inTurns = (item: ThreadItem): boolean => (item.turnId ? selected.has(item.turnId) : item.createdAt >= earliest);
    const turnOf = (item: ThreadItem): number | null => (item.turnId ? turnIndex.get(item.turnId) ?? null : null);
    const entries: TranscriptEntry[] = [];
    const tools = new Map<string, TranscriptEntry>();
    const requests = new Map<string, TranscriptEntry>();
    const tasks = new Map<string, TranscriptEntry>();
    // An anchor names its agent in `subagent.id`; it carries no owner stamp.
    const base = (item: ThreadItem, kind: TranscriptEntry["kind"]): TranscriptEntry => ({ turn: turnOf(item), turnId: item.turnId, kind, createdAt: item.createdAt, ...(item.agentId && kind !== "subagent" ? { agentId: item.agentId } : {}) });
    for (const item of snap.items) {
      if (!inScope(item) || !inTurns(item)) continue;
      if (item.kind === "message") {
        if (item.role === "reasoning" && !opts.include.has("reasoning")) continue;
        const e = base(item, item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "reasoning");
        e.text = item.text;
        if (item.attachments?.length) e.attachments = item.attachments.map((a) => ({ name: a.name, type: a.type }));
        entries.push(e);
        continue;
      }
      const a = item as ThreadActivityItem;
      const p = (a.payload ?? {}) as P;
      if (SKIPPED_ACTIVITY.has(a.activityKind)) continue;
      if (TOOL_KINDS.has(a.activityKind)) {
        if (!opts.include.has("tools")) continue;
        const key = str(p.toolUseId) ?? a.id;
        let e = tools.get(key);
        if (!e) { e = base(a, "tool"); e.tool = { type: str(p.itemType) ?? "tool", title: str(p.title) ?? a.summary, status: str(p.status) ?? "inProgress" }; tools.set(key, e); entries.push(e); }
        const t = e.tool!;
        if (str(p.itemType)) t.type = str(p.itemType)!;
        if (str(p.title)) t.title = str(p.title)!;
        if (str(p.status)) t.status = str(p.status)!;
        if (a.activityKind === "tool.denied") t.status = "declined";
        if (str(p.command)) t.command = str(p.command);
        if (str(p.detail)) t.detail = str(p.detail);
        if (Array.isArray(p.changedFiles)) t.changedFiles = p.changedFiles.filter((f): f is string => typeof f === "string");
        continue;
      }
      if (a.activityKind.startsWith("task.")) {
        if (opts.agentId) continue; // anchors live in the parent view only
        const key = str(p.taskId) ?? a.id;
        let e = tasks.get(key);
        if (!e) { e = base(a, "subagent"); e.subagent = { id: key, title: str(p.title) ?? str(p.description) ?? null, status: str(p.status) ?? "running" }; tasks.set(key, e); entries.push(e); }
        if (str(p.title)) e.subagent!.title = str(p.title)!;
        if (a.activityKind === "task.completed") { const status = str(p.status) ?? "completed"; e.subagent!.status = status === "stopped" ? "interrupted" : status; }
        continue;
      }
      if (a.activityKind === "approval.requested" || a.activityKind === "approval.resolved") {
        if (!opts.include.has("activity")) continue;
        const key = `a:${str(p.requestId) ?? a.id}`;
        let e = requests.get(key);
        if (!e) { e = base(a, "approval"); e.requestId = str(p.requestId) ?? a.id; requests.set(key, e); entries.push(e); }
        if (str(p.requestKind)) e.requestKind = str(p.requestKind);
        if (str(p.detail)) e.text = capText(str(p.detail)!, 2000).text;
        if (a.activityKind === "approval.resolved") e.decision = str(p.decision) ?? "resolved";
        continue;
      }
      if (a.activityKind === "user-input.requested" || a.activityKind === "user-input.resolved") {
        if (!opts.include.has("activity")) continue;
        const key = `q:${str(p.requestId) ?? a.id}`;
        let e = requests.get(key);
        if (!e) { e = base(a, "question"); e.requestId = str(p.requestId) ?? a.id; e.answered = false; requests.set(key, e); entries.push(e); }
        if (Array.isArray(p.questions)) e.questions = (p.questions as P[]).map((q) => str(q.question) ?? str(q.header) ?? "").filter(Boolean);
        if (a.activityKind === "user-input.resolved") e.answered = true;
        continue;
      }
      if (a.activityKind === "turn.proposed.completed") {
        const e = base(a, "plan"); e.text = str(p.planMarkdown) ?? ""; e.actionable = a.id === actionablePlan; entries.push(e); continue;
      }
      if (a.activityKind === "context-compaction") {
        if (!opts.include.has("activity")) continue;
        const e = base(a, "compaction"); e.state = str(p.state) ?? "compacting";
        if (typeof p.beforeTokens === "number") e.beforeTokens = p.beforeTokens;
        if (typeof p.afterTokens === "number") e.afterTokens = p.afterTokens;
        entries.push(e); continue;
      }
      if (!opts.include.has("activity")) continue;
      if (a.tone === "error") { const e = base(a, "error"); e.text = rowText(a, p); entries.push(e); continue; }
      if (a.activityKind === "runtime.warning") { const e = base(a, "warning"); e.text = rowText(a, p); entries.push(e); continue; }
      if (a.activityKind === "session.identity-changed" || a.activityKind === "model.rerouted") { const e = base(a, "info"); e.text = a.summary; entries.push(e); }
    }
    // The roster folds these same rows (a resume reopens, "stopped" is "interrupted", a dead session
    // interrupts) and is what the GUI resolves a spawn row from, so it wins whenever it has the task.
    for (const [id, e] of tasks) { const row = roster.get(id); if (row) e.subagent = rosterView(row); }
    // Per-turn file changes from the checkpoints (§7.6 "changes").
    if (!opts.agentId) {
      for (const cp of snap.checkpoints) {
        if (!cp.turnId || !selected.has(cp.turnId) || !cp.files.length) continue;
        entries.push({ turn: turnIndex.get(cp.turnId) ?? null, turnId: cp.turnId, kind: "changes", createdAt: cp.completedAt, files: cp.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })) });
      }
    }
    entries.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
    return entries;
  };
  const size = (list: TranscriptEntry[]): number => JSON.stringify(list).length;
  let entries = turnCount ? build(from) : [];
  let truncated = false;
  // Shedding order (§7.6): reasoning → tool detail → oldest turns.
  if (size(entries) > opts.maxChars) { truncated = true; entries = entries.filter((e) => e.kind !== "reasoning"); }
  if (size(entries) > opts.maxChars) entries.forEach(shedDetail);
  while (size(entries) > opts.maxChars && from < turnCount) {
    from += 1;
    entries = build(from).filter((e) => e.kind !== "reasoning");
    entries.forEach(shedDetail);
  }
  const subagents = opts.agentId ? [] : snap.roster.map(rosterView);
  return { entries, turnCount, coveredTurns: turnCount ? [from, turnCount] : null, truncated, subagents };
}
