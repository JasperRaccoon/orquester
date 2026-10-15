/**
 * Agent chat — session tools as the timeline sees them (design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §1.1, §1.5).
 *
 * Every agent-chat agent gets an MCP server named `orquester` whose tools run
 * in the daemon (`apps/daemon/src/session-tools/`). A call to one is an
 * ordinary `mcp_tool_call` activity; this module is the provider-neutral
 * reading of one, shared by the slimming (`slim.ts`), the UI's presentation
 * and the daemon's MCP transcript.
 *
 * Each harness spells the tool its own way:
 * - Claude: `mcp__orquester__<tool>` (`data.toolName`);
 * - Codex: `{server: "orquester", tool}` (`data.server` / `data.tool`);
 * - Grok: `orquester__<tool>` (`data.vendorTool`, `_meta["x.ai/tool"].name`),
 *   or — the way it really calls an MCP tool — its `use_tool` meta-tool with
 *   that qualified catalog key in `data.rawInput.tool_name`;
 * - OpenCode: `orquester-<16 hex>_<tool>` (`data.tool`) — one server per
 *   thread on a project's shared `opencode serve`, keyed by a hash of the
 *   thread id (`adapters/opencode/session-tools.ts`).
 */

/** The MCP server name every provider is given. */
export const SESSION_TOOLS_SERVER_NAME = "orquester";

/** A bare session-tool name: what tool descriptions and instructions use. */
export const SESSION_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * OpenCode's per-thread server name: `orquester-` and exactly 16 lowercase hex
 * digits. The fixed width is load-bearing — a permission pattern
 * `orquester-<key>_*` can then never match another thread's server, as a
 * shorter key that is a prefix of a longer one would.
 */
export const OPENCODE_SESSION_TOOLS_SERVER_PATTERN = /^orquester-[0-9a-f]{16}$/;

const SPELLINGS: readonly RegExp[] = [
  /^mcp__orquester__([a-z][a-z0-9_]{0,47})$/,
  /^orquester__([a-z][a-z0-9_]{0,47})$/,
  /^orquester\.([a-z][a-z0-9_]{0,47})$/,
  /^orquester-[0-9a-f]{16}_([a-z][a-z0-9_]{0,47})$/
];

/** Grok's meta-tool that calls an MCP tool by its qualified catalog key (`rawInput.tool_name`). */
export const GROK_USE_TOOL_NAME = "use_tool";

/** The bare tool name a provider-visible spelling names, or null for any other tool. */
export function parseSessionToolName(name: unknown): string | null {
  if (typeof name !== "string") {
    return null;
  }
  for (const spelling of SPELLINGS) {
    const match = spelling.exec(name);
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

/** True for the `orquester` server under any provider's spelling of it. */
export function isSessionToolsServerName(server: unknown): boolean {
  return (
    typeof server === "string" &&
    (server === SESSION_TOOLS_SERVER_NAME || OPENCODE_SESSION_TOOLS_SERVER_PATTERN.test(server))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The bare session-tool name a PROVIDER's activity data spells, under any
 * provider's shape — spelling only, no provenance: a user's own server that
 * shares the `orquester` name spells its tools the same way. The host's
 * ingestion uses it, together with the names it actually registered, to
 * stamp {@link SessionToolMarker} on the rows that are really its own;
 * nothing downstream reads the spelling.
 */
export function sessionToolNameFromProviderData(data: unknown): string | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const item = asRecord(record.item);
  for (const holder of item ? [record, item] : [record]) {
    // Codex names the server apart: then only the server says whose tool it is.
    if (typeof holder.server === "string") {
      if (isSessionToolsServerName(holder.server) && typeof holder.tool === "string") {
        if (SESSION_TOOL_NAME_PATTERN.test(holder.tool)) {
          return holder.tool;
        }
      }
      continue;
    }
    for (const key of ["toolName", "vendorTool", "tool"] as const) {
      const parsed = parseSessionToolName(holder[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
    // Grok's `use_tool`: the called tool is its argument, never the row's own
    // name — read only on a row the adapter says is `use_tool` (`vendorTool`,
    // kept on every frame of the call), never off any tool's arguments.
    const rawInput = asRecord(holder.rawInput);
    if (rawInput && holder.vendorTool === GROK_USE_TOOL_NAME) {
      const parsed = parseSessionToolName(rawInput.tool_name);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

/** What the host's ingestion stamps at `data.sessionTool` on its own session tools' rows. */
export interface SessionToolMarker {
  /** The bare tool name. */
  name: string;
}

/**
 * The bare session-tool name of a row — read ONLY from the provenance marker
 * the host's ingestion stamped (`data.sessionTool`, `sessionToolMarkedData`),
 * never inferred from the spelling. Null for every other call, a same-named
 * user server's included.
 */
export function sessionToolNameOfData(data: unknown): string | null {
  const name = asRecord(asRecord(data)?.sessionTool)?.name;
  return typeof name === "string" && SESSION_TOOL_NAME_PATTERN.test(name) ? name : null;
}

/**
 * `data` with the provenance marker stamped when it names one of the tools the
 * host registered (`registered`), else `data` unchanged. The registered names
 * never include an external `/mcp` tool's (the registry refuses those), so a
 * user's same-named server's calls are never marked.
 */
export function sessionToolMarkedData(data: unknown, registered: ReadonlySet<string>): unknown {
  const record = asRecord(data);
  if (!record || registered.size === 0) {
    return data;
  }
  const name = sessionToolNameFromProviderData(record);
  if (name === null || !registered.has(name)) {
    return data;
  }
  return { ...record, sessionTool: { name } satisfies SessionToolMarker };
}

/**
 * The structured result fields of a session tool the UI renders from, kept
 * through slimming (§1.5) so a row never fetches its full item to render
 * them. A toolkit whose result carries such a field adds its key here;
 * everything else in a result is reduced to the usual one-line summary.
 *
 * - `htmlRender`: the visual-replies toolkit's published page
 *   (`HtmlRenderReference`, `html-render.ts`, design §2.1), read back with
 *   `htmlRenderReferenceOfActivityPayload`.
 * - `secretRequest`: `request_secret`'s record (name, purpose, outcome —
 *   never the value, which `stripSecretRequestValues` removes first).
 * - `threadRef`: the thread a thread or delegation tool created or acted on
 *   (`ThreadToolReference`, `thread-tools.ts`, design §5), read back with
 *   `threadToolReferenceOfActivityData`.
 * - `toolApproval`: the Orquester approval card a call went through, or the
 *   grant that allowed it (`ToolApprovalReference`, `tool-approvals.ts`,
 *   unified MCP design 2026-10-15 §7.3) — never arguments or card secrets —
 *   read back with `toolApprovalReferenceOfActivityData`.
 */
export const SESSION_TOOL_REFERENCE_KEYS: readonly string[] = [
  "htmlRender",
  // `request_secret`: name, purpose and outcome — the card's record, never the value (`secret-requests.ts`).
  "secretRequest",
  "threadRef",
  "toolApproval"
];

/** One kept reference field may take this much JSON; a bigger one is dropped, never cut. */
export const SESSION_TOOL_REFERENCE_MAX_BYTES = 4 * 1024;

/** Result text is only parsed for references below this size. */
const REFERENCE_SCAN_MAX_CHARS = 256 * 1024;

/** How deep the result walk goes: wrapper → blocks → block → nested block → parsed text. */
const REFERENCE_SCAN_MAX_DEPTH = 6;

/**
 * The fields of a result layout the walk descends into, in order: an MCP
 * `CallToolResult`'s `structuredContent` (Codex keeps it) and `content`
 * blocks, a Claude `tool_result`'s `content` (a string or blocks), an ACP
 * content block's `content` wrapper, a text block's `text`, Grok's
 * `use_tool` `rawOutput` (`{type: "MCP", output: {OkayOutput}}` — where Grok
 * 1.0.46 puts an MCP call's result, the text alone: fixtures 32, 33) and an
 * `output` string (OpenCode).
 */
const RESULT_WRAPPER_KEYS = ["structuredContent", "content", "text", "output", "OkayOutput"] as const;

const utf8 = new TextEncoder();

/** `text` parsed as JSON, when that is an object; undefined otherwise. */
function parsedObjectOf(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The structured object a session tool's result carries: the first object,
 * in whichever layout the provider recorded, that holds one of `keys`. The
 * daemon writes it both as `structuredContent` and as a JSON text block
 * (`session-tools/results.ts`); Claude's `tool_result`, OpenCode's output and
 * Grok's `rawOutput.output.OkayOutput` keep only the text.
 */
function structuredResultOf(value: unknown, keys: readonly string[], depth = 0): Record<string, unknown> | null {
  if (depth > REFERENCE_SCAN_MAX_DEPTH || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length > REFERENCE_SCAN_MAX_CHARS) {
      return null;
    }
    if (text.startsWith("{")) {
      const whole = parsedObjectOf(text);
      if (whole !== undefined) {
        return structuredResultOf(whole, keys, depth + 1);
      }
    }
    // Grok's `use_tool` joins a result's text blocks and its
    // `structuredContent` (as JSON) one per line in `OkayOutput` (fixture
    // `32-mcp-use-tool-call.ndjson`): a session tool's `{…}\n{…}` is no one
    // JSON value, so each line that is one is tried, the last first.
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (line.startsWith("{") && line.length < text.length) {
        const parsed = parsedObjectOf(line);
        const found = parsed === undefined ? null : structuredResultOf(parsed, keys, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = structuredResultOf(entry, keys, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (keys.some((key) => Object.hasOwn(record, key))) {
    return record;
  }
  for (const key of RESULT_WRAPPER_KEYS) {
    const found = structuredResultOf(record[key], keys, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Where each provider records a call's result: Codex `data.item.result` or
 * `data.result`; Claude and OpenCode `data.result` (OpenCode also
 * `data.state.output`); Grok `data.rawOutput` and its ACP `data.content`.
 */
function resultsOfData(data: Record<string, unknown>): unknown[] {
  return [asRecord(data.item)?.result, data.result, asRecord(data.state)?.output, data.rawOutput, data.content];
}

/**
 * The reference fields of `keys` a session tool's row carries, each kept
 * whole when its JSON is at most {@link SESSION_TOOL_REFERENCE_MAX_BYTES}.
 * A row slimmed before answers what that slim kept
 * (`data.sessionTool.references`) — its `result` is a summary by then, and a
 * `tool.updated` row is persisted slimmed, then slimmed again for the wire;
 * otherwise the provider's result is read. Undefined when none survives.
 */
export function sessionToolReferences(
  data: Record<string, unknown>,
  keys: readonly string[] = SESSION_TOOL_REFERENCE_KEYS
): Record<string, unknown> | undefined {
  if (keys.length === 0) {
    return undefined;
  }
  const kept = asRecord(asRecord(data.sessionTool)?.references);
  let structured: Record<string, unknown> | null | undefined;
  const references: Record<string, unknown> = {};
  for (const key of keys) {
    let value = kept && Object.hasOwn(kept, key) ? kept[key] : undefined;
    if (value === undefined) {
      if (structured === undefined) {
        structured = null;
        for (const result of resultsOfData(data)) {
          structured = structuredResultOf(result, keys);
          if (structured) {
            break;
          }
        }
      }
      value = structured?.[key];
    }
    if (value === undefined) {
      continue;
    }
    const json = JSON.stringify(value);
    if (json !== undefined && utf8.encode(json).length <= SESSION_TOOL_REFERENCE_MAX_BYTES) {
      references[key] = value;
    }
  }
  return Object.keys(references).length > 0 ? references : undefined;
}

/** What a slimmed session-tool row carries at `data.sessionTool`. */
export interface SessionToolRowData {
  /** The bare tool name. */
  name: string;
  /** The kept reference fields ({@link SESSION_TOOL_REFERENCE_KEYS}). */
  references?: Record<string, unknown>;
}

/** `data.sessionTool` for a slimmed row, or undefined for a call to any other tool. */
export function projectSessionToolData(
  data: Record<string, unknown>,
  keys: readonly string[] = SESSION_TOOL_REFERENCE_KEYS
): SessionToolRowData | undefined {
  const name = sessionToolNameOfData(data);
  if (name === null) {
    return undefined;
  }
  const references = sessionToolReferences(data, keys);
  return references ? { name, references } : { name };
}

// ---------------------------------------------------------------------------
// What a session tool's row persists
// ---------------------------------------------------------------------------

/**
 * A string in a session tool's persisted result is cut past this many UTF-8
 * bytes. The tools' own JSON results stay under the daemon's 60 000-byte cap
 * (`session-tools/results.ts`), so a reference is never cut; what is over it
 * is a blob — a page or an image belongs in an attachment, not in
 * `events.ndjson`.
 */
export const SESSION_TOOL_PERSISTED_STRING_MAX_BYTES = 64 * 1024;

/** A data: URL longer than this loses its bytes. */
const DATA_URL_KEEP_CHARS = 1024;

/**
 * A run of base64 at least this long — an image or file a provider spelled
 * into text — is dropped whole wherever it sits in a string (what follows it,
 * such as Grok's joined JSON, stays). Ordinary text has spaces long before.
 */
export const SESSION_TOOL_BASE64_RUN_MIN_CHARS = 4096;

/** `A-Z a-z 0-9 + / _ -`: the base64 and base64url alphabets. */
function isBase64Char(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 95 ||
    code === 45
  );
}

/**
 * `value` with every base64 run of {@link SESSION_TOOL_BASE64_RUN_MIN_CHARS}+
 * characters (and up to two `=` of padding after it) replaced by a marker —
 * one pass over the string, each character read once, so no input (such as
 * many runs one character short) can make it slow, as a backtracking
 * `/[…]{4096,}/` could. Answers `value` itself when nothing is dropped.
 */
export function dropBase64Runs(value: string): string {
  if (value.length < SESSION_TOOL_BASE64_RUN_MIN_CHARS) return value;
  let parts: string[] | null = null;
  let kept = 0;
  let runStart = -1;
  for (let at = 0; at <= value.length; at += 1) {
    if (at < value.length && isBase64Char(value.charCodeAt(at))) {
      if (runStart === -1) runStart = at;
      continue;
    }
    if (runStart !== -1 && at - runStart >= SESSION_TOOL_BASE64_RUN_MIN_CHARS) {
      let end = at;
      while (end < value.length && end - at < 2 && value.charCodeAt(end) === 61) end += 1;
      parts ??= [];
      parts.push(value.slice(kept, runStart), `[base64 omitted: ${base64Bytes(value.slice(runStart, end))} bytes]`);
      kept = end;
      at = end - 1;
    }
    runStart = -1;
  }
  if (parts === null) return value;
  parts.push(value.slice(kept));
  return parts.join("");
}

/** How deep the walk goes; deeper values are kept as they are. */
const PERSIST_WALK_MAX_DEPTH = 12;

/**
 * The call's own arguments, under each provider's key (Claude `input`, Codex
 * `arguments`, Grok `rawInput`/`tool_input`, OpenCode `state.input`): kept as
 * the agent wrote them, like any tool's.
 */
const ARGUMENT_KEYS: ReadonlySet<string> = new Set(["arguments", "input", "rawInput", "tool_input"]);

/** Approximate decoded size of base64 text. */
function base64Bytes(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

function boundString(value: string): string {
  if (value.startsWith("data:") && value.length > DATA_URL_KEEP_CHARS) {
    const comma = value.indexOf(",");
    const head = comma > 0 && comma < 200 ? value.slice(5, comma) : "data";
    return `[${head} omitted: ${base64Bytes(value.slice(comma + 1))} bytes]`;
  }
  const stripped = dropBase64Runs(value);
  if (stripped !== value) {
    return boundString(stripped);
  }
  if (value.length * 3 <= SESSION_TOOL_PERSISTED_STRING_MAX_BYTES) {
    return value;
  }
  const bytes = utf8.encode(value);
  if (bytes.length <= SESSION_TOOL_PERSISTED_STRING_MAX_BYTES) {
    return value;
  }
  // Cut on a whole character: a decoder drops a split one at the end.
  const head = new TextDecoder().decode(bytes.subarray(0, SESSION_TOOL_PERSISTED_STRING_MAX_BYTES)).replace(/�$/, "");
  return `${head}… [${bytes.length - utf8.encode(head).length} bytes omitted]`;
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return boundString(value);
  }
  if (depth > PERSIST_WALK_MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const bounded = boundValue(entry, depth + 1);
      changed ||= bounded !== entry;
      return bounded;
    });
    return changed ? next : value;
  }
  const record = value as Record<string, unknown>;
  // An image content block: MCP/ACP `{type: "image", data, mimeType}`, or
  // Claude's `{type: "image", source: {type: "base64", data, media_type}}`.
  if (record.type === "image") {
    if (typeof record.data === "string") {
      const { data, ...rest } = record;
      return { ...rest, omittedBytes: base64Bytes(data) };
    }
    const source = asRecord(record.source);
    if (source && typeof source.data === "string") {
      const { data, ...sourceRest } = source;
      return { ...record, source: { ...sourceRest, omittedBytes: base64Bytes(data) } };
    }
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const bounded = ARGUMENT_KEYS.has(key) ? entry : boundValue(entry, depth + 1);
    changed ||= bounded !== entry;
    next[key] = bounded;
  }
  return changed ? next : record;
}

/**
 * A session tool's row data as the host persists it (`events.ndjson`): the
 * bytes of every image in its result dropped — MCP/ACP image content,
 * Claude's base64 image source, OpenCode's data-URL attachments, and any
 * base64 run of {@link SESSION_TOOL_BASE64_RUN_MIN_CHARS}+ characters inside
 * a string — and any other string past
 * {@link SESSION_TOOL_PERSISTED_STRING_MAX_BYTES} cut. The
 * model got the full result already; the timeline renders a session tool
 * from its reference fields and labels, which stay whole. The call's
 * arguments are kept as written. Answers `data` itself when nothing changed.
 */
export function boundSessionToolData(data: unknown): unknown {
  return boundValue(data, 0);
}
