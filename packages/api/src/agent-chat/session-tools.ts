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
 * - Grok: `orquester__<tool>` (`data.vendorTool`, `_meta["x.ai/tool"].name`);
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
 * them. A toolkit whose result carries such a field adds its key here (e.g.
 * the visual-replies toolkit's `htmlRender`); everything else in a result is
 * reduced to the usual one-line summary.
 */
export const SESSION_TOOL_REFERENCE_KEYS: readonly string[] = [
  // `request_secret`: name, purpose and outcome — the card's record, never the value (`secret-requests.ts`).
  "secretRequest"
];

/** One kept reference field may take this much JSON; a bigger one is dropped, never cut. */
export const SESSION_TOOL_REFERENCE_MAX_BYTES = 4 * 1024;

/** Results are only parsed for references below this size. */
const REFERENCE_SCAN_MAX_CHARS = 256 * 1024;

const utf8 = new TextEncoder();

/**
 * The structured object a session tool's result carries, from whichever shape
 * the provider recorded: an MCP `CallToolResult`'s `structuredContent`, else
 * its first text block parsed as a JSON object (Claude's `tool_result` block
 * and OpenCode's output text carry only the text; the daemon writes the same
 * object as JSON text there, `session-tools/results.ts`), else a bare JSON
 * string.
 */
function structuredResultOf(result: unknown): Record<string, unknown> | null {
  const record = asRecord(result);
  const structured = asRecord(record?.structuredContent);
  if (structured) {
    return structured;
  }
  let text: string | null = null;
  if (typeof result === "string") {
    text = result;
  } else if (record && typeof record.content === "string") {
    text = record.content;
  } else if (record && Array.isArray(record.content)) {
    text = firstTextBlock(record.content);
  } else if (Array.isArray(result)) {
    // Grok's ACP `content`: `[{type: "content", content: {type: "text", text}}]`.
    text = firstTextBlock(result);
  }
  if (text === null || text.length > REFERENCE_SCAN_MAX_CHARS) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** The first text of an MCP content array, or of ACP's `{type: "content", content}` wrappers. */
function firstTextBlock(blocks: readonly unknown[]): string | null {
  for (const entry of blocks) {
    const block = asRecord(entry);
    const candidate = block?.text ?? asRecord(block?.content)?.text;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

/** The result a provider recorded for a call, wherever its data holds it. */
function resultOfData(data: Record<string, unknown>): unknown {
  const item = asRecord(data.item);
  if (item && item.result !== undefined) {
    return item.result;
  }
  if (data.result !== undefined) {
    return data.result;
  }
  // Grok: the ACP `content` the model read, before `rawOutput`, whose shape
  // for an MCP call is the CLI's own.
  if (Array.isArray(data.content)) {
    return data.content;
  }
  return data.rawOutput;
}

/**
 * The reference fields of `keys` a session tool's result carries, each kept
 * whole when its JSON is at most {@link SESSION_TOOL_REFERENCE_MAX_BYTES}.
 * Undefined when none survives.
 */
export function sessionToolReferences(
  data: Record<string, unknown>,
  keys: readonly string[] = SESSION_TOOL_REFERENCE_KEYS
): Record<string, unknown> | undefined {
  if (keys.length === 0) {
    return undefined;
  }
  const structured = structuredResultOf(resultOfData(data));
  if (!structured) {
    return undefined;
  }
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    const value = structured[key];
    if (value === undefined) {
      continue;
    }
    const json = JSON.stringify(value);
    if (json !== undefined && utf8.encode(json).length <= SESSION_TOOL_REFERENCE_MAX_BYTES) {
      kept[key] = value;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
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
