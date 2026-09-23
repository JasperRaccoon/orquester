import { ACTIVE_SUBAGENT_STATUSES, commandDisplayDetail, compactionMarkerState, isAgentOwnedActivity, isCompactionActivity, isPlanImplementationMessage, startedTurns, type RuntimeSubagent, type StartedTurn, type ThreadActivityItem, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { capText } from "./result.ts";

export type TranscriptInclude = "reasoning" | "tools" | "activity";
export interface TranscriptEntry { turn: number | null; turnId: string | null; kind: "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "subagent" | "plan" | "changes" | "compaction" | "error" | "warning" | "info"; createdAt: string; agentId?: string; text?: string;
  /** On an assistant row only: the provider marked it narration between tool calls (Codex's commentary), never the turn's answer. */
  commentary?: true;
  attachments?: { name: string; type: string }[]; tool?: { type: string; title: string; status: string; command?: string; detail?: string; changedFiles?: string[] };
  /**
   * On a tool row only: where more of the call's output is read, by read_tool_output as `itemId`. The id of the latest
   * of the call's rows whose payload the read cut (`payload.truncated`, §5.6) and the host stores whole — its completion
   * or a denial, the row the GUI's "Load full output" reads; else, for a call that streamed output (`tool.output` rows,
   * which only the host can join whole), its latest row. Absent when the snapshot shows neither.
   */
  outputItemId?: string;
  requestId?: string; requestKind?: string; decision?: string;
  questions?: string[]; answered?: boolean; subagent?: { id: string; title: string | null; status: string }; actionable?: boolean; files?: { path: string; additions: number; deletions: number }[]; state?: string; beforeTokens?: number; afterTokens?: number }
export interface TranscriptOptions {
  /** How many turns the read covers, and `beforeTurn` which ones: the range `transcriptRange` names. */
  turns: number; beforeTurn?: number; agentId?: string; include: ReadonlySet<TranscriptInclude>;
  /**
   * The size budget for the WHOLE result — entries, turns, subagents and flags — in UTF-8 bytes of its JSON, as ok()
   * counts (the name predates the unit). A result that fits it — with the hint it will carry about `unavailable`
   * turns, if any — comes back whole. One that does not is shed to TRANSCRIPT_HINT_BYTES under it (and that hint's
   * bytes more), which leaves room for the hint the caller adds, so the tool's whole answer keeps within `maxChars`
   * either way.
   */
  maxChars: number;
  /**
   * The turns of the range the snapshot could not supply whole (history.ts), and the sentence the caller's hint says
   * about them: the result reports the turns as `unavailableTurns` and holds back the sentence's bytes.
   */
  unavailable?: { turns: [number, number]; hint: string };
  /**
   * The thread's retained window, when `snap` also carries the older rows a history page supplied (history.ts). The
   * actionable plan is judged on it alone, as the host judges it: a plan that aged out of the window is not the one
   * implement_plan would send. Absent: `snap.items` is the window.
   */
  windowItems?: readonly ThreadItem[];
}
export interface TranscriptResult {
  entries: TranscriptEntry[]; turnCount: number;
  /**
   * The started turns before the first turn this result delivers: the range's `start − 1`, or, when the shed dropped
   * rows, `coveredTurns[0] − 1`. `beforeTurn: olderTurns + 1` then reads the turns just before those — a turn whose
   * rows the shed dropped included — so paging back never skips a turn, and always moves back.
   */
  olderTurns: number;
  coveredTurns: [number, number] | null;
  /** The first and last turn of the range that could not be read whole — only when some could not. */
  unavailableTurns?: [number, number];
  truncated: boolean; subagents: { id: string; title: string | null; status: string }[]; subagentsTruncated?: boolean;
}

/**
 * The room a shed result leaves under `maxChars` for the caller's `hint` field — key, quotes and comma included. A
 * result with `unavailable` turns leaves that sentence's bytes and a space more.
 */
export const TRANSCRIPT_HINT_BYTES = 320;
/** What a `hint` field adds to a result besides its text: `,"hint":""`. */
const HINT_FIELD_BYTES = 10;
/**
 * The subagent list's share of the room once a result is over it: the list takes whatever the transcript does not
 * need, and never less than this fraction when it needs it.
 */
export const ROSTER_SHARE = 0.25;

const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);
// A hook's start and progress are provider bookkeeping, as its successful completion is (below); the GUI keeps only
// a completion that failed or was cancelled.
const SKIPPED_ACTIVITY = new Set(["tool.output", "tool.progress", "turn.proposed.delta", "turn.plan.updated", "hook.started", "hook.progress", "context-window.updated", "checkpoint.captured", "background.requested", "task.progress", "task.updated"]);

/** A tool's `detail` after the second shed: at most this many characters, the cut marked by the trailing "…". */
const SHED_DETAIL_CHARS = 200;
/**
 * A subagent's text wherever the tools show it — its title here, in the roster and on its anchor; its title, progress
 * and error in a session detail (views.ts): at most this many code points, a cut marked the same way.
 */
export const SUBAGENT_TEXT_CHARS = 200;

type P = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const asRecord = (v: unknown): P | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as P) : undefined);
/** `text` cut to at most `max` code points, the last of them a "…" when anything was cut. */
const capped = (text: string, max: number): string => (capText(text, max).truncated ? `${capText(text, max - 1).text}…` : text);
const subagentTitle = (title: string | null | undefined): string | null => (title == null ? null : capped(title, SUBAGENT_TEXT_CHARS));
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

/**
 * The thread's latest proposed plan, and whether it is actionable: the host's own `hasActionableProposedPlan` rule
 * (orchestrator.ts) — the LATEST plan, until a later user message implements it — judged on the snapshot just read.
 * The ONE place the tools decide it: get_session's `plan.actionable` (views.ts), the transcript's plan rows (below)
 * and implement_plan's check (tools/messages.ts). The summary's flag says the same one host poll late: right after
 * implement_plan it still flags the plan just sent, and right after a plan lands it does not flag it yet.
 */
export function proposedPlan(items: readonly ThreadItem[]): { item: ThreadActivityItem; actionable: boolean } | null {
  let implemented = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) implemented = true;
    else if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") return { item, actionable: !implemented };
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

/**
 * `text` without its shortest tail of whole code points whose JSON size is at least `need` bytes, and that size: one
 * pass from the end, over the lost tail only. A surrogate pair goes whole; a lone surrogate is one code point too (JSON
 * writes it \uXXXX). The head is `text` itself when `need` ≤ 0, and "" when the whole text is not enough.
 */
export function cutTail(text: string, need: number): { head: string; saved: number } {
  let end = text.length;
  let saved = 0;
  while (end > 0 && saved < need) {
    const last = text.charCodeAt(end - 1);
    const pair = end >= 2 && last >= 0xdc00 && last <= 0xdfff && (text.charCodeAt(end - 2) & 0xfc00) === 0xd800;
    saved += codePointBytes(pair ? text.codePointAt(end - 2)! : last);
    end -= pair ? 2 : 1;
  }
  return { head: text.slice(0, end), saved };
}

const ELLIPSIS_BYTES = 3; // "…" (U+2026), which JSON leaves unescaped

/** Suffix sums: `sums[i]` is the total of `values[i…]`, so any tail's total is read in O(1). */
function suffixSums(values: readonly number[]): number[] {
  const sums = new Array<number>(values.length + 1).fill(0);
  for (let i = values.length - 1; i >= 0; i -= 1) sums[i] = sums[i + 1]! + values[i]!;
  return sums;
}
const more = (count: number, noun: string): string => `…${count} more ${noun}${count === 1 ? "" : "s"}`;

/** A part of the spared row that can be shortened in place: its bytes in the row's JSON, and a cut by `need` returning what it saved. */
interface Part { bytes: number; cut: (need: number) => number }

/**
 * `entry` cut until its JSON is at least `need` bytes smaller, its biggest part first. A text field keeps its head and
 * ends in "…". A list — a checkpoint's files, a tool's changed files, a message's attachments — keeps its head and one
 * last element of its own shape counting the rest (a checkpoint's also carries the rest's line totals), so the row's
 * type holds. Null when even every part at its minimum would not do: the row's skeleton does not fit.
 */
function cutRow(entry: TranscriptEntry, need: number): { row: TranscriptEntry; saved: number } | null {
  const row: TranscriptEntry = { ...entry };
  const parts: Part[] = [];
  const text = (value: string, set: (text: string) => void): void => {
    const bytes = jsonTextBytes(value);
    parts.push({ bytes, cut: (want) => {
      if (bytes <= ELLIPSIS_BYTES) return 0; // the mark would cost what the cut saves
      const kept = headWithin(value, Math.max(0, bytes - want - ELLIPSIS_BYTES));
      set(`${kept.head}…`);
      return bytes - kept.bytes - ELLIPSIS_BYTES;
    } });
  };
  const list = <T>(items: readonly T[], marker: (from: number) => T, set: (kept: T[]) => void): void => {
    const sizes = items.map((item) => jsonByteSize(item) + 1);
    const bytes = contentBytes(sizes.reduce((sum, n) => sum + n, 0), items.length);
    parts.push({ bytes, cut: (want) => {
      // The longest head that, with the marker for the rest, saves at least `want`; else the marker alone.
      const markerBytes = (from: number): number => jsonByteSize(marker(from));
      let keep = 0;
      let head = 0;
      while (keep < items.length - 1 && head + sizes[keep]! + markerBytes(keep + 1) <= bytes - want) head += sizes[keep++]!;
      const saved = bytes - head - markerBytes(keep);
      if (saved <= 0) return 0;
      set([...items.slice(0, keep), marker(keep)]);
      return saved;
    } });
  };
  if (row.text !== undefined) text(row.text, (value) => { row.text = value; });
  if (row.tool) {
    const tool = (row.tool = { ...row.tool });
    text(tool.title, (value) => { tool.title = value; });
    if (tool.command !== undefined) text(tool.command, (value) => { tool.command = value; });
    if (tool.detail !== undefined) text(tool.detail, (value) => { tool.detail = value; });
    const changed = tool.changedFiles;
    if (changed?.length) list(changed, (from) => more(changed.length - from, "file"), (kept) => { tool.changedFiles = kept; });
  }
  if (row.subagent?.title) {
    const subagent = (row.subagent = { ...row.subagent });
    text(subagent.title!, (value) => { subagent.title = value; });
  }
  if (row.questions) {
    const questions = (row.questions = [...row.questions]);
    questions.forEach((question, i) => text(question, (value) => { questions[i] = value; }));
  }
  const files = row.files;
  if (files?.length) {
    const added = suffixSums(files.map((f) => f.additions));
    const deleted = suffixSums(files.map((f) => f.deletions));
    list(files, (from) => ({ path: more(files.length - from, "file"), additions: added[from]!, deletions: deleted[from]! }), (kept) => { row.files = kept; });
  }
  const attachments = row.attachments;
  if (attachments?.length) list(attachments, (from) => ({ name: more(attachments.length - from, "attachment"), type: "omitted" }), (kept) => { row.attachments = kept; });
  let saved = 0;
  for (const part of parts.sort((a, b) => b.bytes - a.bytes)) {
    if (saved >= need) break;
    saved += part.cut(need - saved);
  }
  return saved >= need ? { row, saved } : null;
}

/**
 * The row a shed never drops: the latest turn's final assistant reply, else that turn's newest row. A commentary row
 * is narration, never the reply (the GUI never takes it for the turn's answer).
 */
function sparedIndex(rows: readonly TranscriptEntry[]): number {
  let latest: number | null = null;
  for (const e of rows) if (e.turn !== null && (latest === null || e.turn > latest)) latest = e.turn;
  let newest = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.turn !== latest) continue;
    if (rows[i]!.kind === "assistant" && !rows[i]!.commentary) return i;
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
export const sized = <T>(rows: readonly T[]): Sized<T>[] => rows.map((row) => ({ row, bytes: jsonByteSize(row) + 1 }));
/** A list's JSON inside the result, brackets excluded: every row's bytes but the last comma. */
const contentBytes = (sum: number, count: number): number => (count > 0 ? sum - 1 : 0);

/**
 * A subagent list within `allowance` bytes (its JSON, brackets excluded): settled rows go first, then live ones
 * (pending, running, waiting), each first seen first. The one rule for both lists that shed subagents — the
 * transcript's roster here and a session detail's `subagents` (views.ts). Pure, and linear: every row was measured once.
 */
export function fitRoster<T extends { status: string }>(rows: readonly Sized<T>[], allowance: number): { rows: T[]; bytes: number; trimmed: boolean } {
  let sum = rows.reduce((total, r) => total + r.bytes, 0);
  let count = rows.length;
  const gone = new Set<Sized<T>>();
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
 * spared row (`sparedIndex`) is never dropped: it is cut last, its biggest part first (`cutRow`). Empty only when not
 * even that row's skeleton fits. Returns the entries' exact size with them. Pure, and linear: every row was measured once.
 */
export function fitEntries(entries: readonly Sized<TranscriptEntry>[], allowance: number): { entries: TranscriptEntry[]; bytes: number } {
  const rows = entries.map((e) => ({ ...e }));
  let sum = rows.reduce((total, r) => total + r.bytes, 0);
  let count = rows.length;
  const over = (): boolean => contentBytes(sum, count) > allowance;
  if (count === 0 || !over()) return { entries: rows.map((r) => r.row), bytes: contentBytes(sum, count) };
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
    if (cut === null) return { entries: [], bytes: 0 };
    rows[spared] = { row: cut.row, bytes: rows[spared]!.bytes - cut.saved };
    sum -= cut.saved;
  }
  return { entries: rows.filter((_, i) => !gone.has(i)).map((r) => r.row), bytes: contentBytes(sum, count) };
}

/**
 * The turns a read covers, by started-turn ordinal: the `turns` turns just before `beforeTurn`, else the latest `turns`
 * — `end` = `beforeTurn − 1` (default `turnCount`), `start` = max(1, end − turns + 1). The tool refuses a `beforeTurn`
 * outside 2..turnCount + 1; here one is clamped, so the range never leaves 1..turnCount. It is empty (end < start) when
 * the thread has no started turn.
 */
export function transcriptRange(turnCount: number, turns: number, beforeTurn?: number): { start: number; end: number } {
  const end = Math.max(0, Math.min(turnCount, (beforeTurn ?? turnCount + 1) - 1));
  return { start: Math.max(1, end - Math.max(1, Math.floor(turns)) + 1), end };
}

/**
 * The turn an item belongs to: its own `turnId`, else — for a turn's opening message, which the host writes with the
 * idle session's null turnId — the turn that names it back as `userMessageId` (fold.ts), its only link.
 */
export function itemTurnId(turns: readonly StartedTurn[]): (item: ThreadItem) => string | null {
  const opened = new Map<string, string>();
  for (const t of turns) if (t.userMessageId) opened.set(t.userMessageId, t.turnId);
  return (item) => item.turnId ?? (item.kind === "message" ? opened.get(item.id) ?? null : null);
}

export function transcriptEntries(snap: ThreadSnapshotPayload, opts: TranscriptOptions): TranscriptResult {
  // 1. Turn numbering: the ordinal among STARTED turns (turns.ts), the same number
  //    revert_session and get_turn_diff speak in; the highest is turnCount.
  const ordered = startedTurns(snap.turns);
  const turnIndex = new Map<string, number>();
  ordered.forEach((t, i) => turnIndex.set(t.turnId, i + 1));
  const turnIdOf = itemTurnId(ordered);
  const turnCount = ordered.length;
  // 2. The range read, [start, end]; the turns before it are the caller's to page back to (`olderTurns`, below).
  const { start, end } = transcriptRange(turnCount, opts.turns, opts.beforeTurn);
  const roster = new Map(snap.roster.map((r) => [r.id, r]));
  const latestPlan = proposedPlan(opts.windowItems ?? snap.items);
  const actionablePlan = latestPlan?.actionable ? latestPlan.item.id : null;
  const build = (): TranscriptEntry[] => {
    const selected = new Set(ordered.slice(start - 1, end).map((t) => t.turnId));
    // A row with no turn — a turn the host never started: its message, its failure — belongs to the range by its time:
    // from the range's first turn on (from the very start when that is turn 1), and before the turn after the range.
    const earliest = start > 1 ? ordered[start - 1]!.requestedAt : "";
    const beyond = end < turnCount ? ordered[end]!.requestedAt : null;
    // An AGENT's task row anchors it in the parent view even when it carries an agentId (Codex, OpenCode
    // and Grok stamp the task's own id on it); a stamped background shell's row stays out, as in the GUI.
    const isAgentAnchor = (item: ThreadItem): boolean => item.kind === "activity" && item.activityKind.startsWith("task.") && ((item.payload ?? {}) as P).agentKind === "agent";
    const inScope = (item: ThreadItem): boolean => (opts.agentId ? item.agentId === opts.agentId : !item.agentId || isAgentAnchor(item));
    const inTurns = (item: ThreadItem): boolean => {
      const id = turnIdOf(item);
      return id ? selected.has(id) : item.createdAt >= earliest && (beyond === null || item.createdAt < beyond);
    };
    const turnOf = (item: ThreadItem): number | null => { const id = turnIdOf(item); return id ? turnIndex.get(id) ?? null : null; };
    const entries: TranscriptEntry[] = [];
    const tools = new Map<string, TranscriptEntry>();
    const requests = new Map<string, TranscriptEntry>();
    const tasks = new Map<string, TranscriptEntry>();
    // The calls that streamed output (`tool.output` rows), and each call's latest lifecycle row in the range.
    const streamed = new Set<string>();
    const latestRow = new Map<string, string>();
    // An anchor names its agent in `subagent.id`; it carries no owner stamp.
    const base = (item: ThreadItem, kind: TranscriptEntry["kind"]): TranscriptEntry => ({ turn: turnOf(item), turnId: turnIdOf(item), kind, createdAt: item.createdAt, ...(item.agentId && kind !== "subagent" ? { agentId: item.agentId } : {}) });
    for (const item of snap.items) {
      if (!inScope(item)) continue;
      // A chunk of a call's streamed output is never a row, but it says the call has output only the host can join
      // whole. Counted wherever it falls in the view, not only in the range: a background shell outlives the turn that
      // launched it, and its chunks carry whichever turn is live when they arrive.
      if (item.kind === "activity" && item.activityKind === "tool.output") {
        const callId = str(asRecord(item.payload)?.toolUseId);
        if (callId) streamed.add(callId);
        continue;
      }
      if (!inTurns(item)) continue;
      if (item.kind === "message") {
        if (item.role === "reasoning" && !opts.include.has("reasoning")) continue;
        const e = base(item, item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "reasoning");
        e.text = item.text;
        if (item.role === "assistant" && item.messageKind === "commentary") e.commentary = true;
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
        // The payload's command, else its data's, as the GUI's row reads it (Grok's rides only in `data`).
        const command = str(p.command) ?? str(asRecord(p.data)?.command);
        if (command) t.command = command;
        // A command's detail is what the GUI's row shows (`commandDisplayDetail`): the provider's, or the output its
        // data carries where that detail is empty, repeats the title or only echoes the command. An activity that
        // gives none — an echo with no output yet — leaves the detail an earlier one gave, as the GUI's row keeps it.
        // Never the start's: the GUI drops `tool.started`, and Grok's first frame carries no ACP `kind`, so its echo of
        // the command would read as a detail and outlive a completion with no output.
        const detail = p.itemType !== "command_execution" ? str(p.detail) : a.activityKind === "tool.started" ? undefined : commandDisplayDetail(p);
        if (detail) t.detail = detail;
        if (Array.isArray(p.changedFiles)) t.changedFiles = p.changedFiles.filter((f): f is string => typeof f === "string");
        // Where the whole of what the read cut lives (`truncated`, the slimmer's promise, §5.6): the latest cut row of
        // those the host stores whole — the completion or a denial, the row the GUI's "Load full output" reads. Never
        // the start, which the GUI does not show, nor an update: ingestion stores a `tool.updated` already cut, so its
        // item holds nothing its row does not (the GUI's button on a running call reads that same preview back). The
        // denial half is forward-compatible: a denial carries no `data` today and is never cut on the wire, so it
        // names no id until one carries more than the read can show.
        if (p.truncated === true && (a.activityKind === "tool.completed" || a.activityKind === "tool.denied")) e.outputItemId = a.id;
        if (str(p.toolUseId)) latestRow.set(key, a.id);
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
      // A compaction marker in the GUI's reading (`@orquester/api` compaction.ts): a `context-compaction` row or an old
      // log's `thread.state.changed {state: "compacted"}`, in the state the GUI shows — an unreadable one is settled.
      // A subagent compacting its own context (an agentId on the row or on its payload) is not the conversation's:
      // the parent view leaves it out, as the GUI's timeline does.
      if (isCompactionActivity(a)) {
        if (!opts.include.has("activity") || (!opts.agentId && isAgentOwnedActivity(a))) continue;
        const e = base(a, "compaction"); e.state = compactionMarkerState(a);
        if (typeof p.beforeTokens === "number") e.beforeTokens = p.beforeTokens;
        if (typeof p.afterTokens === "number") e.afterTokens = p.afterTokens;
        entries.push(e); continue;
      }
      if (!opts.include.has("activity")) continue;
      if (a.activityKind === "hook.completed" && p.outcome === "success") continue;
      // A hook that failed is an error row (its tone), one cancelled — or ending any other way — a warning row.
      if (a.tone === "error") { const e = base(a, "error"); e.text = rowText(a, p); entries.push(e); continue; }
      if (a.activityKind === "runtime.warning" || a.activityKind === "hook.completed") { const e = base(a, "warning"); e.text = rowText(a, p); entries.push(e); continue; }
      if (a.activityKind === "session.identity-changed" || a.activityKind === "model.rerouted") { const e = base(a, "info"); e.text = a.summary; entries.push(e); }
    }
    // A call whose output was streamed — a background shell's, a running command's so far — has it in no item's data:
    // the host joins the chunks (`GET …/items/:itemId/output`). Where no cut completion already names the call, its
    // latest row does: read_tool_output resolves the call from any of its rows.
    for (const [callId, rowId] of latestRow) {
      const e = tools.get(callId)!;
      if (e.outputItemId === undefined && streamed.has(callId)) e.outputItemId = rowId;
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
  const entries = build();
  const agents = opts.agentId ? [] : snap.roster.map(rosterView);
  const unavailable = opts.unavailable;
  // One shape for the result and for its frame, so what is measured is what is returned.
  const shaped = (list: TranscriptEntry[], subagents: RosterRow[], covered: [number, number] | null, olderTurns: number, truncated: boolean, subagentsTruncated: boolean): TranscriptResult => ({
    entries: list, turnCount, olderTurns, coveredTurns: covered, ...(unavailable ? { unavailableTurns: unavailable.turns } : {}), truncated, subagents, ...(subagentsTruncated ? { subagentsTruncated: true } : {})
  });
  // `olderTurns` counts back from the first turn delivered. A shed drops whole rows oldest first, so once it has dropped
  // any, the range's first turns may have none left: counting from `start` would page past them, and the caller would
  // never be shown them. From `coveredTurns[0]` the next read takes them in.
  const result = (list: TranscriptEntry[], subagents: RosterRow[], truncated: boolean, subagentsTruncated: boolean): TranscriptResult => {
    const covered = coveredOf(list);
    const dropped = list.length < entries.length;
    return shaped(list, subagents, covered, dropped && covered ? covered[0] - 1 : start - 1, truncated, subagentsTruncated);
  };
  // The frame is the result with both lists empty. A result whose frame, entries (E) and subagent list (R) fit
  // maxChars comes back whole: nothing shed, no flags, and so no hint — but for the sentence about unavailable turns,
  // whose field it must leave room for. Only a shed one keeps TRANSCRIPT_HINT_BYTES free, plus that sentence and the
  // space the caller joins the two with.
  const frame = (covered: [number, number] | null, olderTurns: number, truncated: boolean, subagentsTruncated: boolean): number => jsonByteSize(shaped([], [], covered, olderTurns, truncated, subagentsTruncated));
  const said = unavailable ? jsonTextBytes(unavailable.hint) : 0;
  const budget = opts.maxChars - TRANSCRIPT_HINT_BYTES - (unavailable ? said + 1 : 0);
  const sizedEntries = sized(entries);
  const sizedAgents = sized(agents);
  const entryBytes = contentBytes(sizedEntries.reduce((sum, r) => sum + r.bytes, 0), sizedEntries.length);
  const agentBytes = contentBytes(sizedAgents.reduce((sum, a) => sum + a.bytes, 0), sizedAgents.length);
  const wholeHint = unavailable ? HINT_FIELD_BYTES + said : 0;
  if (frame(coveredOf(entries), start - 1, false, false) + entryBytes + agentBytes + wholeHint <= opts.maxChars) return result(entries, agents, false, false);
  // Over it (§7.6 and its fix-round rulings), in the widest frame — `coveredTurns` and `olderTurns` at their most digits,
  // as neither is known before the shed: the subagent list takes what the entries do not need and never less than
  // ROSTER_SHARE of the room when it needs it; the entries get exactly what it leaves.
  const widest: [number, number] | null = turnCount > 0 ? [turnCount, turnCount] : null;
  const room = budget - frame(widest, turnCount, true, true);
  let listed = fitRoster(sizedAgents, Math.max(Math.floor(room * ROSTER_SHARE), room - entryBytes));
  const fitted = fitEntries(sizedEntries, budget - frame(widest, turnCount, true, listed.trimmed) - listed.bytes);
  // What the entries leave unused goes back to the roster: one more pass over that room. It can only re-add rows,
  // the last dropped first (live ones, newest first), since the entries never used more than the first pass left.
  // The first pass's `room − E` term is kept as ruled but has been redundant since this pass: on a shed result it
  // always trims the roster, so this pass still runs and finds the same rows. It spares nothing.
  if (listed.trimmed) listed = fitRoster(sizedAgents, room - fitted.bytes);
  return result(fitted.entries, listed.rows, true, listed.trimmed);
}
