/**
 * Grok adapter — tool-call bounding, coalescing and kind normalisation
 * (spec §4.5 Grok "Tool output must be bounded and coalesced or it floods the
 * bus").
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/acp/AcpRuntimeModel.ts`
 * (`:282-320`, `:338-442`, `:444-466`, `:588-666`).
 *
 * Grok resends the **whole accumulated output** on every `tool_call_update` —
 * confirmed in `apps/daemon/test/fixtures/grok/03b-bash-output-accumulation.ndjson`
 * for a one-line `echo hi`:
 *
 * ```
 * in_progress  content=[{"text":""}]      rawOutput.output_for_prompt=""            total_bytes=0
 * in_progress  content=[{"text":"hi\n"}]  rawOutput.output_for_prompt="hi\n"        total_bytes=3
 * completed    content=[{"text":"hi\n"}]  rawOutput.output_for_prompt="exit: 0\nhi\n"
 * ```
 *
 * Two extra fields T3's list does not know about, both from the same capture:
 * `rawOutput.output_for_prompt` (cumulative text) and `rawOutput.output` — a
 * **byte array** (`[104,105,10]`) that grows without bound on a chatty
 * command and would otherwise be copied verbatim into every event.
 */

import type { CanonicalRequestType, ToolLifecycleItemType } from "@orquester/api/agent-chat";

/** Bounded output keeps the LAST this-many characters. */
export const TOOL_CALL_CONTENT_MAX_CHARS = 8_000;
export const TOOL_CALL_CONTENT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n";
/** A byte array in `rawOutput` keeps its last this-many entries. */
export const TOOL_CALL_RAW_BYTES_MAX = 4_096;

/**
 * `rawOutput` fields holding accumulated TEXT. T3's four, plus the two Grok
 * actually uses.
 *
 * *T3: `AcpRuntimeModel.ts:300` — `["content","stdout","stderr","output"]`.*
 */
export const RAW_OUTPUT_TEXT_FIELDS: readonly string[] = [
  "content",
  "content_concise",
  "stdout",
  "stderr",
  "output",
  "output_for_prompt",
  "tool_output_for_prompt",
  "tool_output_for_prompt_concise",
  "raw_output"
];

/** Fields holding an accumulated byte array. */
export const RAW_OUTPUT_BYTE_FIELDS: readonly string[] = ["output", "stdout", "stderr"];

/**
 * ≤ the cap passes through unchanged; otherwise keep the **tail** and prepend
 * the marker. The tail, not the head: a `tool_call_update` routinely omits
 * `kind`, so a redrawing progress bar is indistinguishable from real output
 * and the end is the useful part.
 */
export function boundToolOutputText(text: string): string {
  if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return text;
  }
  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${text.slice(-TOOL_CALL_CONTENT_MAX_CHARS)}`;
}

/**
 * Bound every accumulated field of a `rawOutput` object.
 *
 * **Returns the original reference when nothing changed** — referential
 * identity is a protocol here, because {@link toolOutputUnchanged} compares
 * with `===`. Cloning defensively turns every update into a change and
 * defeats coalescing outright.
 */
export function boundRawOutput(rawOutput: unknown): unknown {
  if (rawOutput === null || typeof rawOutput !== "object" || Array.isArray(rawOutput)) {
    return rawOutput;
  }
  const source = rawOutput as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && RAW_OUTPUT_TEXT_FIELDS.includes(key)) {
      const bounded = boundToolOutputText(value);
      if (bounded !== value) {
        changed = true;
      }
      next[key] = bounded;
      continue;
    }
    if (Array.isArray(value) && RAW_OUTPUT_BYTE_FIELDS.includes(key) && value.length > TOOL_CALL_RAW_BYTES_MAX) {
      next[key] = value.slice(-TOOL_CALL_RAW_BYTES_MAX);
      changed = true;
      continue;
    }
    // One level down: Grok nests its real payload under a discriminated key
    // (`{"type":"ReadFile","FileContent":{content,…}}`), so a top-level-only
    // walk would bound nothing on a read.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const bounded = boundRawOutput(value);
      if (bounded !== value) {
        changed = true;
      }
      next[key] = bounded;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : rawOutput;
}

/** One `ToolCallContent` entry, as far as bounding is concerned. */
interface ToolContentEntry {
  readonly type?: string;
  readonly content?: { readonly type?: string; readonly text?: string } | null;
  readonly [key: string]: unknown;
}

/**
 * Bound each text entry of a `content[]` array independently. Same identity
 * rule as {@link boundRawOutput}.
 */
export function boundToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  let changed = false;
  const next = content.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      return entry;
    }
    const record = entry as ToolContentEntry;
    const inner = record.content;
    if (record.type !== "content" || inner === null || inner === undefined || typeof inner.text !== "string") {
      return entry;
    }
    const bounded = boundToolOutputText(inner.text);
    if (bounded === inner.text) {
      return entry;
    }
    changed = true;
    return { ...record, content: { ...inner, text: bounded } };
  });
  return changed ? next : content;
}

/** The joined, bounded text of a `content[]` array, or undefined. */
export function toolContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as ToolContentEntry;
    if (record.type !== "content") {
      continue;
    }
    const text = record.content?.text;
    if (typeof text !== "string") {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return boundToolOutputText(chunks.join("\n"));
}

// ---------------------------------------------------------------------------
// Coalescing (§4.5: "always on completed/failed or a title/status change,
// otherwise only when progress grew ≥ 256 chars or 10 updates were skipped")
// ---------------------------------------------------------------------------

export const TOOL_UPDATE_MIN_GROWTH_CHARS = 256;
export const TOOL_UPDATE_COALESCE_LIMIT = 10;

export interface ToolCallSnapshot {
  readonly title?: string;
  readonly status?: string;
  readonly detail?: string;
  readonly content?: unknown;
  readonly rawOutput?: unknown;
}

export interface CoalesceDecision {
  readonly emit: boolean;
  readonly skipped: number;
}

/**
 * By reference, which works only because the bounding helpers preserve
 * identity when nothing changed.
 */
export function toolOutputUnchanged(previous: ToolCallSnapshot, next: ToolCallSnapshot): boolean {
  return previous.content === next.content && previous.rawOutput === next.rawOutput;
}

/**
 * How much has actually been produced. Measuring only `detail` was T3's
 * original bug: a command tool pins `detail` to the command string, so live
 * stdout growth would never be seen and in-progress output would be withheld
 * until the tool completed.
 */
export function toolProgressLength(snapshot: ToolCallSnapshot): number {
  let length = snapshot.detail?.length ?? 0;
  if (Array.isArray(snapshot.content)) {
    let sum = 0;
    for (const entry of snapshot.content) {
      const text = (entry as ToolContentEntry | null)?.content?.text;
      if (typeof text === "string") {
        sum += text.length;
      }
    }
    length = Math.max(length, sum);
  }
  const raw = snapshot.rawOutput;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    let sum = 0;
    for (const field of RAW_OUTPUT_TEXT_FIELDS) {
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value === "string") {
        sum += value.length;
      }
    }
    length = Math.max(length, sum);
  }
  return length;
}

/**
 * *T3: `AcpRuntimeModel.ts:588-666` (`decideToolCallUpdateEmission`).*
 *
 * Note `Math.abs`: a *shrinking* bounded tail window is also meaningful
 * movement. And an **unchanged** update does not count as a skip — counting
 * those would fire a pointless emission every ten no-op notifications.
 */
export function decideToolEmission(input: {
  readonly previous?: ToolCallSnapshot;
  readonly next: ToolCallSnapshot;
  readonly lastEmittedProgressLength?: number;
  readonly skippedSinceEmit: number;
}): CoalesceDecision {
  const { previous, next, lastEmittedProgressLength, skippedSinceEmit } = input;

  if (next.status === "completed" || next.status === "failed") {
    return { emit: true, skipped: 0 };
  }
  if (previous === undefined || previous.title !== next.title || previous.status !== next.status) {
    return { emit: true, skipped: 0 };
  }
  if (previous.detail === next.detail && toolOutputUnchanged(previous, next)) {
    return { emit: false, skipped: skippedSinceEmit };
  }
  const progress = toolProgressLength(next);
  const grew =
    lastEmittedProgressLength === undefined ||
    Math.abs(progress - lastEmittedProgressLength) >= TOOL_UPDATE_MIN_GROWTH_CHARS;
  if (grew || skippedSinceEmit + 1 >= TOOL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skipped: 0 };
  }
  return { emit: false, skipped: skippedSinceEmit + 1 };
}

// ---------------------------------------------------------------------------
// Kind normalisation (§4.5). TWO maps, differing on `read` and on
// `search`/`fetch`. They are not interchangeable.
// ---------------------------------------------------------------------------

/** ACP `ToolKind` → the item type an activity row is classified under. */
export function itemTypeFromToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      // `read` lands here deliberately — T3's item map has no `read` case,
      // only its *permission* map does.
      return "dynamic_tool_call";
  }
}

/** ACP `ToolKind` → the canonical request type of an approval (§4.3). */
export function requestTypeFromToolKind(kind: string | undefined): CanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

/** Trimmed, or undefined when blank. */
export function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

/**
 * The shell command a tool call is running, if it has one. Grok's `rawInput`
 * is `{variant:"Bash", command, description, is_background}`; other providers
 * use `executable`/`args`, and the title may carry it in backticks.
 *
 * *T3: `AcpRuntimeModel.ts:468-539` + `extractCommandFromTitle` at `:256`.*
 */
export function extractToolCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const record = rawInput as Record<string, unknown>;
    const command = record["command"];
    if (typeof command === "string" && command.trim().length > 0) {
      return command.trim();
    }
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
      const joined = (command as string[]).join(" ").trim();
      if (joined.length > 0) {
        return joined;
      }
    }
    const executable = record["executable"];
    if (typeof executable === "string" && executable.trim().length > 0) {
      const args = record["args"];
      if (Array.isArray(args) && args.every((part) => typeof part === "string")) {
        return `${executable.trim()} ${(args as string[]).join(" ")}`.trim();
      }
      return executable.trim();
    }
  }
  if (typeof title === "string") {
    const match = /`([^`]+)`/.exec(title);
    if (match !== null && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}
