import { ACTIVE_SUBAGENT_STATUSES, isPlanImplementationMessage, startedTurns, type RuntimeSubagent, type ThreadActivityItem, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { capText } from "./result.ts";

export type TranscriptInclude = "reasoning" | "tools" | "activity";
export interface TranscriptEntry { turn: number | null; turnId: string | null; kind: "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "subagent" | "plan" | "changes" | "compaction" | "error" | "warning" | "info"; createdAt: string; agentId?: string; text?: string;
  attachments?: { name: string; type: string }[]; tool?: { type: string; title: string; status: string; command?: string; detail?: string; changedFiles?: string[] }; requestId?: string; requestKind?: string; decision?: string;
  questions?: string[]; answered?: boolean; subagent?: { id: string; title: string | null; status: string }; actionable?: boolean; files?: { path: string; additions: number; deletions: number }[]; state?: string; beforeTokens?: number; afterTokens?: number }
export interface TranscriptOptions {
  turns: number; agentId?: string; include: ReadonlySet<TranscriptInclude>;
  /**
   * The size budget for the WHOLE result — entries, turns, subagents and flags — in UTF-8 bytes of its JSON, as ok()
   * counts (the name predates the unit). A truncated result stays TRANSCRIPT_HINT_BYTES under it, which leaves room for
   * the truncation hint the caller adds, so the tool's whole answer keeps within `maxChars` too.
   */
  maxChars: number;
}
export interface TranscriptResult { entries: TranscriptEntry[]; turnCount: number; coveredTurns: [number, number] | null; truncated: boolean; subagents: { id: string; title: string | null; status: string }[]; subagentsTruncated?: boolean }

/** The room a truncated result leaves under `maxChars` for the caller's `hint` field — key, quotes and comma included. */
export const TRANSCRIPT_HINT_BYTES = 320;

const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);
const SKIPPED_ACTIVITY = new Set(["tool.output", "tool.progress", "turn.proposed.delta", "turn.plan.updated", "hook.started", "hook.progress", "hook.completed", "context-window.updated", "checkpoint.captured", "background.requested", "task.progress", "task.updated"]);

/** A tool's `detail` after the second shed: at most this many characters, the cut marked by the trailing "…". */
const SHED_DETAIL_CHARS = 200;
/** A subagent's title, in the roster and on its anchor: at most this many code points, a cut marked the same way. */
const SUBAGENT_TITLE_CHARS = 200;

type P = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** `text` cut to at most `max` code points, the last of them a "…" when anything was cut. */
const capped = (text: string, max: number): string => (capText(text, max).truncated ? `${capText(text, max - 1).text}…` : text);
const shedDetail = (e: TranscriptEntry): void => {
  if (e.tool?.detail) e.tool.detail = capped(e.tool.detail, SHED_DETAIL_CHARS);
};
const subagentTitle = (title: string | null | undefined): string | null => (title == null ? null : capped(title, SUBAGENT_TITLE_CHARS));
/**
 * Label plus detail, as the GUI's row shows them; runtime.error and runtime.warning keep their text in
 * `message`. A warning is labelled with its own message cut short, so then the message alone says it.
 */
const rowText = (a: ThreadActivityItem, p: P): string => {
  const detail = str(p.detail);
  if (detail) return `${a.summary}: ${detail}`;
  const message = str(p.message);
  if (!message) return a.summary;
  return message.startsWith(a.summary.replace(/(?:\.\.\.|…)$/u, "")) ? message : `${a.summary}: ${message}`;
};
const rosterView = (r: RuntimeSubagent): NonNullable<TranscriptEntry["subagent"]> => ({ id: r.id, title: subagentTitle(r.title), status: r.status });

/** The host's `hasActionableProposedPlan` rule: the LATEST proposed plan, until a later user message implements it. */
function actionablePlanId(items: readonly ThreadItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) return null;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") return item.id;
  }
  return null;
}

/** A value's size as the budget counts it: its JSON in UTF-8 bytes, the unit of ok()'s cap (result.ts). */
const jsonByteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The least k in [0, n] for which the monotone `ok(k)` holds, by bisection; n when none below it does. */
function least(n: number, ok: (k: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The latest turn's own shed, for when it is over the budget on its own (§7.6: `maxChars` is a hard budget): its
 * OLDEST rows go first, sparing the final reply (else the newest row); when that row alone is still over, it keeps
 * the longest head of its text that fits. A spared row that cannot fit even so — no text to cut, or over without
 * it — gives way to the next, so a turn with any row that fits never comes back empty. `size` measures a candidate
 * list the way the budget does.
 */
function fitBudget(entries: TranscriptEntry[], budget: number, size: (list: TranscriptEntry[]) => number): TranscriptEntry[] {
  for (let rows = entries; rows.length > 0; ) {
    const reply = rows.map((e) => e.kind).lastIndexOf("assistant");
    const spared = reply >= 0 ? reply : rows.length - 1;
    let total = size(rows);
    const kept = rows.filter((e, i) => {
      if (i === spared || total <= budget) return true;
      total -= jsonByteSize(e) + 1; // a dropped row takes one comma with it: the spared row keeps the list non-empty
      return false;
    });
    if (total <= budget) return kept;
    // Only the spared row is left. Its text's cost per code point varies (JSON escapes, and the encoding), so the
    // cut is found by bisection over whole code points, measuring each candidate as the budget does.
    const row = kept[0]!;
    const text = row.text ?? "";
    const cut = (n: number): TranscriptEntry[] => [{ ...row, text: `${capText(text, n).text}…` }];
    const head = least([...text].length, (n) => size(cut(n)) > budget) - 1;
    if (head > 0) return cut(head);
    rows = rows.filter((_, i) => i !== spared);
  }
  return [];
}

export function transcriptEntries(snap: ThreadSnapshotPayload, opts: TranscriptOptions): TranscriptResult {
  // 1. Turn numbering: the ordinal among STARTED turns (turns.ts), the same number
  //    revert_session and get_turn_diff speak in; the highest is turnCount.
  const ordered = startedTurns(snap.turns);
  const turnIndex = new Map<string, number>();
  ordered.forEach((t, i) => turnIndex.set(t.turnId, i + 1));
  // The host writes a turn's opening message with the session's activeTurnId, which is null while the
  // thread is idle; the turn names that message back as `userMessageId` (fold.ts), its only link.
  const openedTurn = new Map<string, string>();
  for (const t of ordered) if (t.userMessageId) openedTurn.set(t.userMessageId, t.turnId);
  const turnIdOf = (item: ThreadItem): string | null => item.turnId ?? (item.kind === "message" ? openedTurn.get(item.id) ?? null : null);
  const turnCount = ordered.length;
  const wanted = Math.max(1, Math.floor(opts.turns));
  let from = Math.max(1, turnCount - wanted + 1);
  const roster = new Map(snap.roster.map((r) => [r.id, r]));
  const actionablePlan = actionablePlanId(snap.items);
  const build = (fromTurn: number): TranscriptEntry[] => {
    const selected = new Set(ordered.slice(fromTurn - 1).map((t) => t.turnId as string));
    // A row with no turn counts from the window's first turn on, or from the very start when the window
    // starts at turn 1: a turn the host never started (its message, its failure) has no turn at all.
    const earliest = fromTurn > 1 ? ordered[fromTurn - 1]!.requestedAt : "";
    // An AGENT's task row anchors it in the parent view even when it carries an agentId (Codex, OpenCode
    // and Grok stamp the task's own id on it); a stamped background shell's row stays out, as in the GUI.
    const isAgentAnchor = (item: ThreadItem): boolean => item.kind === "activity" && item.activityKind.startsWith("task.") && ((item.payload ?? {}) as P).agentKind === "agent";
    const inScope = (item: ThreadItem): boolean => (opts.agentId ? item.agentId === opts.agentId : !item.agentId || isAgentAnchor(item));
    const inTurns = (item: ThreadItem): boolean => { const id = turnIdOf(item); return id ? selected.has(id) : item.createdAt >= earliest; };
    const turnOf = (item: ThreadItem): number | null => { const id = turnIdOf(item); return id ? turnIndex.get(id) ?? null : null; };
    const entries: TranscriptEntry[] = [];
    const tools = new Map<string, TranscriptEntry>();
    const requests = new Map<string, TranscriptEntry>();
    const tasks = new Map<string, TranscriptEntry>();
    // An anchor names its agent in `subagent.id`; it carries no owner stamp.
    const base = (item: ThreadItem, kind: TranscriptEntry["kind"]): TranscriptEntry => ({ turn: turnOf(item), turnId: turnIdOf(item), kind, createdAt: item.createdAt, ...(item.agentId && kind !== "subagent" ? { agentId: item.agentId } : {}) });
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
        if (!e) { e = base(a, "subagent"); e.subagent = { id: key, title: subagentTitle(str(p.title) ?? str(p.description)), status: str(p.status) ?? "running" }; tasks.set(key, e); entries.push(e); }
        if (str(p.title)) e.subagent!.title = subagentTitle(str(p.title));
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
  // The roster in the order it is shed: settled rows, then live ones (pending, running, waiting), first seen first.
  const agents = opts.agentId ? [] : snap.roster;
  const live = (r: RuntimeSubagent): boolean => ACTIVE_SUBAGENT_STATUSES.has(r.status);
  const shedOrder = [...agents.filter((r) => !live(r)), ...agents.filter(live)];
  const settledCount = shedOrder.length - agents.filter(live).length;
  let shed = 0; // how many of shedOrder the result leaves out
  let entries = build(from);
  let truncated = false;
  // The budget bounds the whole result as the caller receives it; `coveredTurns` names turns with rows present.
  const result = (list: TranscriptEntry[]): TranscriptResult => {
    const gone = new Set(shedOrder.slice(0, shed));
    const r: TranscriptResult = { entries: list, turnCount, coveredTurns: turnCount > 0 && list.some((e) => e.turn !== null) ? [from, turnCount] : null, truncated, subagents: agents.filter((a) => !gone.has(a)).map(rosterView) };
    if (shed > 0) r.subagentsTruncated = true;
    return r;
  };
  const budget = (): number => Math.max(0, opts.maxChars - (truncated ? TRANSCRIPT_HINT_BYTES : 0));
  const size = (list: TranscriptEntry[]): number => jsonByteSize(result(list));
  const over = (): boolean => size(entries) > budget();
  // Shedding order (§7.6 and its fix-round ruling): (1) reasoning, (2) tool detail, (3) the oldest turns — never
  // the latest turn's own rows, the floor of the window.
  if (over()) { truncated = true; entries = entries.filter((e) => e.kind !== "reasoning"); }
  if (over()) entries.forEach(shedDetail);
  while (over() && from < turnCount) {
    from += 1;
    entries = build(from).filter((e) => e.kind !== "reasoning");
    entries.forEach(shedDetail);
  }
  if (over()) {
    // (4) Settled subagent rows, as few as lets the latest turn's rows stay whole; (5) with every settled row gone,
    // the latest turn's oldest rows, then the reply's tail (fitBudget); (6) only when not even a head of a row fits
    // beside them, the live rows too. The roster is recoverable whole through get_session.
    const floor = entries;
    const attempt = (k: number): TranscriptEntry[] | null => {
      shed = k;
      if (size(floor) <= budget()) return floor;
      if (k < settledCount) return null;
      const fitted = fitBudget(floor, budget(), size);
      return fitted.length > 0 ? fitted : null;
    };
    entries = attempt(least(shedOrder.length, (k) => attempt(k) !== null)) ?? [];
  }
  return result(entries);
}
