/**
 * Agent chat — activity payload slimming (spec §5.6).
 *
 * Ported from T3 Code (MIT): `apps/server/src/orchestration/ActivityPayloadProjection.ts`.
 *
 * The full payload is persisted and this runs before anything goes on the
 * wire — with one exception: a `tool.updated` row is persisted **already
 * slimmed**, because a streaming update's `data` carries the whole tool output
 * accumulated so far and a new row is written per chunk, so persisting it
 * verbatim writes O(N²) bytes for one tool call. The matching `tool.completed`
 * row persists the full payload and is what `GET …/items/:itemId` reads.
 *
 * Rules the implementation owes:
 * - cap any string at {@link SLIM_MAX_STRING_BYTES} on the wire, keeping the
 *   full value on disk, and stamp `truncated: true` so the UI can offer "load
 *   full output";
 * - rebuild `payload.data` from an **allow-list** rather than truncating in
 *   place — the size is in the structure, not in one long string;
 * - an MCP tool call keeps `type, id, tool, server, status, arguments,
 *   appContext, error, durationMs` and nothing else, and its `result` is
 *   reduced to a one-line summary;
 * - tool text output is summarised to the first meaningful line, elided at
 *   {@link SLIM_SUMMARY_ELIDE_CHARS}, or to `"N lines"` when there is no
 *   single renderable line;
 * - changed files are a path list, at most {@link SLIM_MAX_CHANGED_FILES}
 *   entries and {@link SLIM_MAX_CHANGED_FILE_DEPTH} levels deep;
 * - a payload whose top-level `status` is `completed` while its nested item
 *   status is `failed` or `declined` is **re-stamped** with the item status,
 *   so a failed tool never renders as a success.
 *
 * Only `payload.data` is rebuilt; every other top-level field survives
 * untouched (bar the string cap). That is load-bearing: the roster fold
 * (§7.6) and the presentation resolver (§7.2) read the task linkage bundle
 * and {@link ThreadActivityPayloadFields} straight off the top level of a
 * SLIMMED payload, so stripping there would empty the roster on the wire.
 */

/** Any string in an activity payload is capped at this on the wire. */
export const SLIM_MAX_STRING_BYTES = 16 * 1024;
/** Tool text output is elided at this many characters. */
export const SLIM_SUMMARY_ELIDE_CHARS = 84;
export const SLIM_MAX_CHANGED_FILES = 12;
export const SLIM_MAX_CHANGED_FILE_DEPTH = 4;

/** Fields an MCP tool call keeps. *T3: `ActivityPayloadProjection.ts:190-207`.* */
export const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs"
] as const;

/** How deep the string cap walks before it gives up and drops the branch. */
const MAX_CAP_DEPTH = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Summarise tool text output to its first meaningful line, elided at
 * {@link SLIM_SUMMARY_ELIDE_CHARS}, or `"N lines"` when no single line is
 * renderable.
 *
 * *T3: `ActivityPayloadProjection.ts:164-188`.*
 */
export function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  let offset = 0;

  while (offset <= value.length) {
    const newlineIndex = value.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(offset, lineEnd).replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      meaningfulLineCount += 1;
      if (line !== "```") {
        const summary =
          line.length <= SLIM_SUMMARY_ELIDE_CHARS
            ? line
            : `${line.slice(0, SLIM_SUMMARY_ELIDE_CHARS - 1).trimEnd()}…`;
        // V8 can retain the full tool output behind a short sliced string.
        // Join a tiny character array so the returned preview owns its bytes.
        return Array.from(summary).join("");
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    offset = newlineIndex + 1;
  }

  return meaningfulLineCount > 1 ? `${meaningfulLineCount} lines` : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

/** *T3: `ActivityPayloadProjection.ts:24-81`.* */
function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number
): void {
  if (depth > SLIM_MAX_CHANGED_FILE_DEPTH || target.length >= SLIM_MAX_CHANGED_FILES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= SLIM_MAX_CHANGED_FILES) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations"
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= SLIM_MAX_CHANGED_FILES) {
      return;
    }
  }
}

/**
 * Pull renderable text out of an MCP tool result: a Codex-style
 * `{content: [{type: "text", text}, …]}` record, or a raw Claude `tool_result`
 * block whose `content` is a string or a block array.
 *
 * *T3: `ActivityPayloadProjection.ts:209-234`.*
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/** *T3: `ActivityPayloadProjection.ts:82-124` (`projectCommandData`).* */
function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

/** *T3: `ActivityPayloadProjection.ts:126-143` (`projectCommandValue`).* */
function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }
  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }
  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }
  return undefined;
}

/** *T3: `ActivityPayloadProjection.ts:311-360` (`projectMcpToolCallData`).* */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projected.item = projectedItem;
  }

  if ("toolName" in data) {
    projected.toolName = data.toolName;
  }
  if ("input" in data) {
    projected.input = data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projected.result = result;
    }
  }
  if ("toolCallId" in data) {
    projected.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projected.kind = data.kind;
  }

  return projected;
}

/** *T3: `ActivityPayloadProjection.ts:362-400` (`projectRawOutput`).* */
function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const summary = summarizeToolTextOutput(direct);
    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {})
    };
  }

  for (const key of ["content", "stdout", "stderr"] as const) {
    const text = asTrimmedString(rawOutput[key]);
    if (text) {
      const summary = summarizeToolTextOutput(text);
      return summary ? { content: summary } : undefined;
    }
  }

  return undefined;
}

/** ACP content blocks (`[{type: "content", content: {type: "text", text}}]`). */
function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const summary = summarizeToolTextOutput(text);
  return summary ? { content: summary } : undefined;
}

/**
 * The string cap. Walks the value and truncates any string longer than
 * {@link SLIM_MAX_STRING_BYTES}; returns the SAME reference when nothing
 * needed capping, so a snapshot of small rows costs no allocation.
 *
 * Flags `truncated` through the shared box so the caller can stamp the
 * payload once rather than once per nested string.
 */
function capStrings(value: unknown, flag: { truncated: boolean }, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length <= SLIM_MAX_STRING_BYTES) {
      return value;
    }
    flag.truncated = true;
    // Own the bytes: a slice can retain the whole source string in V8.
    return `${Array.from(value.slice(0, SLIM_MAX_STRING_BYTES)).join("")}…`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_CAP_DEPTH) {
    flag.truncated = true;
    return Array.isArray(value) ? [] : {};
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const capped = capStrings(entry, flag, depth + 1);
      if (capped !== entry) {
        changed = true;
      }
      return capped;
    });
    return changed ? next : value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const capped = capStrings(entry, flag, depth + 1);
    if (capped !== entry) {
      changed = true;
    }
    next[key] = capped;
  }
  return changed ? next : value;
}

/**
 * The single choke point every read passes through (§5.6). Returns the value
 * unchanged (same reference) when nothing needed slimming, so a snapshot of
 * small rows costs no allocation.
 */
export function slimActivityPayload(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) {
    const flag = { truncated: false };
    return capStrings(payload, flag, 0);
  }

  const data = asRecord(record.data);

  // The status re-stamp runs even when there is no `data` record to rebuild:
  // a failed tool must never render as a success (§5.6).
  const itemStatus = asRecord(data?.item)?.status;
  const restamped =
    record.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...record, status: itemStatus }
      : record;

  if (!data) {
    const flag = { truncated: false };
    const capped = capStrings(restamped, flag, 0) as Record<string, unknown>;
    if (!flag.truncated) {
      return restamped === record ? payload : restamped;
    }
    return { ...capped, truncated: true };
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);

  let projectedData: Record<string, unknown>;
  if (record.itemType === "mcp_tool_call") {
    projectedData = projectMcpToolCallData(data);
  } else {
    projectedData = {};
    const item = projectCommandData(data);
    if (item) {
      projectedData.item = item;
    }
    const command = projectCommandValue(data);
    if (command !== undefined) {
      projectedData.command = command;
    }
    if ("toolCallId" in data) {
      projectedData.toolCallId = data.toolCallId;
    }
    if ("kind" in data) {
      projectedData.kind = data.kind;
    }
    if ("toolName" in data) {
      projectedData.toolName = data.toolName;
    }
    const rawOutput =
      projectRawOutput(data.rawOutput) ??
      projectAcpContent(data.content) ??
      (record.itemType === "command_execution" ? summarizeMcpResult(data.result) : undefined);
    if (rawOutput) {
      projectedData.rawOutput = rawOutput;
    }
  }

  const next: Record<string, unknown> = { ...restamped, data: projectedData };
  if (changedFiles.length > 0) {
    // Promoted to the top level: `changedFiles` is one of the allow-listed
    // fields the §7.2 presentation resolver reads (differs from T3, which
    // leaves the list at `data.files`).
    next.changedFiles = changedFiles;
  }

  const flag = { truncated: droppedAnything(data, projectedData) };
  const capped = capStrings(next, flag, 0) as Record<string, unknown>;
  if (!flag.truncated) {
    return capped;
  }
  // `truncated` is a promise the reader can act on: it means
  // `GET …/items/:itemId` really does hold more than this row (§5.6).
  capped.truncated = true;
  return capped;
}

/**
 * True when the allow-list rebuild lost anything, so `truncated` is only
 * stamped on rows where `GET …/items/:itemId` genuinely has more. Identity
 * comparison is deliberate and conservative: a value rebuilt into a fresh
 * object (a summarised result, a `{command}` projection) counts as dropped,
 * which is exactly what it is.
 */
function droppedAnything(
  original: Record<string, unknown>,
  projected: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(original)) {
    if (!(key in projected) || projected[key] !== value) {
      return true;
    }
  }
  return false;
}
