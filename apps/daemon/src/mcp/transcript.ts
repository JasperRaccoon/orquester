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
/**
 * The subagent list's share of the room once a result is over it: the list takes whatever the transcript does not
 * need, and never less than this fraction when it needs it.
 */
export const ROSTER_SHARE = 0.25;

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

/** One code point's size inside a JSON string, escaped as JSON.stringify escapes it, in UTF-8 bytes. */
function codePointBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2; // \" and \\
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6; // \b \t \n \f \r, else \u00XX
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate, written \udXXX
  return cp < 0x10000 ? 3 : 4;
}

/** A string's size inside a JSON result — escaped, UTF-8, quotes excluded — counted, never serialised. */
export function jsonTextBytes(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += codePointBytes(ch.codePointAt(0)!);
  return bytes;
}

/** The longest head of `text`, whole code points, whose JSON size is at most `budget` bytes. */
function headWithin(text: string, budget: number): { head: string; bytes: number } {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cost = codePointBytes(ch.codePointAt(0)!);
    if (bytes + cost > budget) break;
    bytes += cost;
    end += ch.length;
  }
  return { head: text.slice(0, end), bytes };
}

const ELLIPSIS_BYTES = 3; // "…" (U+2026), which JSON leaves unescaped

/**
 * `entry` with its free text cut until its JSON is at least `need` bytes smaller: the longest text field first, a
 * cut field ending in "…". Null when even every field cut down to the mark would not do.
 */
function cutRow(entry: TranscriptEntry, need: number): TranscriptEntry | null {
  const row: TranscriptEntry = { ...entry };
  const fields: { text: string; set: (text: string) => void }[] = [];
  if (row.text !== undefined) fields.push({ text: row.text, set: (text) => { row.text = text; } });
  if (row.tool) {
    const tool = (row.tool = { ...row.tool });
    fields.push({ text: tool.title, set: (text) => { tool.title = text; } });
    if (tool.command !== undefined) fields.push({ text: tool.command, set: (text) => { tool.command = text; } });
    if (tool.detail !== undefined) fields.push({ text: tool.detail, set: (text) => { tool.detail = text; } });
  }
  if (row.subagent?.title) {
    const subagent = (row.subagent = { ...row.subagent });
    fields.push({ text: subagent.title!, set: (text) => { subagent.title = text; } });
  }
  if (row.questions) {
    const questions = (row.questions = [...row.questions]);
    questions.forEach((question, i) => fields.push({ text: question, set: (text) => { questions[i] = text; } }));
  }
  const bySize = fields.map((f) => ({ ...f, bytes: jsonTextBytes(f.text) })).sort((a, b) => b.bytes - a.bytes);
  for (const field of bySize) {
    if (need <= 0) break;
    if (field.bytes <= ELLIPSIS_BYTES) continue; // the mark would cost what the cut saves
    const { head, bytes } = headWithin(field.text, Math.max(0, field.bytes - need - ELLIPSIS_BYTES));
    field.set(`${head}…`);
    need -= field.bytes - bytes - ELLIPSIS_BYTES;
  }
  return need <= 0 ? row : null;
}

/** The row a shed never drops: the latest turn's final assistant reply, else that turn's newest row. */
function sparedIndex(rows: readonly TranscriptEntry[]): number {
  let latest: number | null = null;
  for (const e of rows) if (e.turn !== null && (latest === null || e.turn > latest)) latest = e.turn;
  let newest = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.turn !== latest) continue;
    if (rows[i]!.kind === "assistant") return i;
    if (newest < 0) newest = i;
  }
  return newest;
}

/** The turns the rows present belong to, first and last; null when none belongs to one. */
function coveredOf(rows: readonly TranscriptEntry[]): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const e of rows) if (e.turn !== null) { first = Math.min(first, e.turn); last = Math.max(last, e.turn); }
  return last >= first ? [first, last] : null;
}

type RosterRow = NonNullable<TranscriptEntry["subagent"]>;
const LIVE: ReadonlySet<string> = ACTIVE_SUBAGENT_STATUSES;

/** A row with the bytes it adds to its JSON array — its own JSON plus the comma joining it — measured once. */
export interface Sized<T> { row: T; bytes: number }
const sized = <T>(rows: readonly T[]): Sized<T>[] => rows.map((row) => ({ row, bytes: jsonByteSize(row) + 1 }));
/** A list's JSON inside the result, brackets excluded: every row's bytes but the last comma. */
const contentBytes = (sum: number, count: number): number => (count > 0 ? sum - 1 : 0);

/**
 * The subagent list within `allowance` bytes (its JSON, brackets excluded): settled rows go first, then live ones
 * (pending, running, waiting), each first seen first. Pure, and linear: every row was measured once.
 */
export function fitRoster(rows: readonly Sized<RosterRow>[], allowance: number): { rows: RosterRow[]; bytes: number; trimmed: boolean } {
  let sum = rows.reduce((total, r) => total + r.bytes, 0);
  let count = rows.length;
  const gone = new Set<Sized<RosterRow>>();
  for (const r of [...rows.filter((x) => !LIVE.has(x.row.status)), ...rows.filter((x) => LIVE.has(x.row.status))]) {
    if (contentBytes(sum, count) <= allowance) break;
    gone.add(r);
    sum -= r.bytes;
    count -= 1;
  }
  return { rows: rows.filter((r) => !gone.has(r)).map((r) => r.row), bytes: contentBytes(sum, count), trimmed: gone.size > 0 };
}

/**
 * The entries within `allowance` bytes (their JSON, brackets excluded), in one pass: reasoning rows, then tool
 * detail, then whole rows, each oldest first — the oldest turn's rows, then the latest turn's own older ones. The
 * spared row (`sparedIndex`) is never dropped: it is cut last, its longest text field first. Empty only when not
 * even that row, cut to its minimum, fits. Pure, and linear: every row was measured once.
 */
export function fitEntries(entries: readonly Sized<TranscriptEntry>[], allowance: number): { entries: TranscriptEntry[]; shed: boolean } {
  const rows = entries.map((e) => ({ ...e }));
  let sum = rows.reduce((total, r) => total + r.bytes, 0);
  let count = rows.length;
  const over = (): boolean => contentBytes(sum, count) > allowance;
  if (count === 0 || !over()) return { entries: rows.map((r) => r.row), shed: false };
  const spared = sparedIndex(rows.map((r) => r.row));
  const gone = new Set<number>();
  const drop = (i: number): void => { gone.add(i); sum -= rows[i]!.bytes; count -= 1; };
  // Reasoning rows, oldest first.
  for (let i = 0; i < rows.length && over(); i += 1) if (i !== spared && rows[i]!.row.kind === "reasoning") drop(i);
  // Tool detail, oldest first, down to SHED_DETAIL_CHARS: the size moves by the text's own bytes, never re-measured.
  for (let i = 0; i < rows.length && over(); i += 1) {
    const r = rows[i]!;
    const detail = r.row.tool?.detail;
    if (gone.has(i) || detail === undefined) continue;
    const kept = capped(detail, SHED_DETAIL_CHARS);
    if (kept === detail) continue;
    const saved = jsonTextBytes(detail) - jsonTextBytes(kept);
    rows[i] = { row: { ...r.row, tool: { ...r.row.tool!, detail: kept } }, bytes: r.bytes - saved };
    sum -= saved;
  }
  // Whole rows, oldest first; then, alone, the spared row is cut.
  for (let i = 0; i < rows.length && over(); i += 1) if (i !== spared && !gone.has(i)) drop(i);
  if (over()) {
    const cut = cutRow(rows[spared]!.row, contentBytes(sum, count) - allowance);
    if (cut === null) return { entries: [], shed: true };
    rows[spared]!.row = cut; // its size is not read again
  }
  return { entries: rows.filter((_, i) => !gone.has(i)).map((r) => r.row), shed: true };
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
  const entries = build(from);
  const agents = opts.agentId ? [] : snap.roster.map(rosterView);
  const result = (list: TranscriptEntry[], subagents: RosterRow[], truncated: boolean, subagentsTruncated: boolean): TranscriptResult => {
    const r: TranscriptResult = { entries: list, turnCount, coveredTurns: coveredOf(list), truncated, subagents };
    if (subagentsTruncated) r.subagentsTruncated = true;
    return r;
  };
  // The frame is the result with both lists empty. A result keeps TRANSCRIPT_HINT_BYTES of maxChars free for the
  // caller's hint, and fits whole when the entries (E) and the subagent list (R) fit what the frame leaves.
  const frame = (covered: [number, number] | null, truncated: boolean, subagentsTruncated: boolean): number =>
    jsonByteSize({ entries: [], turnCount, coveredTurns: covered, truncated, subagents: [], ...(subagentsTruncated ? { subagentsTruncated } : {}) });
  const budget = opts.maxChars - TRANSCRIPT_HINT_BYTES;
  const sizedEntries = sized(entries);
  const sizedAgents = sized(agents);
  const entryBytes = contentBytes(sizedEntries.reduce((sum, r) => sum + r.bytes, 0), sizedEntries.length);
  const agentBytes = contentBytes(sizedAgents.reduce((sum, a) => sum + a.bytes, 0), sizedAgents.length);
  if (frame(coveredOf(entries), false, false) + entryBytes + agentBytes <= budget) return result(entries, agents, false, false);
  // Over it (§7.6 and its fix-round rulings), in the widest frame: the subagent list takes what the entries do not
  // need and never less than ROSTER_SHARE of the room when it needs it; the entries get exactly what it leaves.
  const widest: [number, number] | null = turnCount > 0 ? [turnCount, turnCount] : null;
  const room = budget - frame(widest, true, true);
  const listed = fitRoster(sizedAgents, Math.max(Math.floor(room * ROSTER_SHARE), room - entryBytes));
  const fitted = fitEntries(sizedEntries, budget - frame(widest, true, listed.trimmed) - listed.bytes);
  return result(fitted.entries, listed.rows, true, listed.trimmed);
}
