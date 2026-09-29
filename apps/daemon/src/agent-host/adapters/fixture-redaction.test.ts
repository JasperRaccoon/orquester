/**
 * The protocol fixtures' redaction post-check.
 *
 * Every set under `apps/daemon/test/fixtures/` is real traffic recorded on the build host, and
 * each README says what was redacted before it was committed. This is the automated check of that
 * promise, and it reads what a per-line rule cannot: a value a provider STREAMED in pieces is
 * joined the way its protocol streams it, and the joined text is scanned beside every line. A home
 * path the Claude CLI streamed as `/var/l` + `ib/orquester/…` passed the per-line redaction in
 * eight captures, one of them spelling a managed account's id, while the same captures' complete
 * frames held `~` (2026-09-27). A byte array — a Grok tool's `rawOutput.output` or `stdout` — is
 * scanned decoded, for the same reason: one in Grok's `07` spelled the home past every text rule.
 *
 * Host-independent: it reads the committed fixtures and nothing else of this host, and every rule
 * is a shape. What a README documents as a placeholder or a deliberate fake is allowed by the
 * exact text a rule matched ({@link ALLOWED}).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const FIXTURES_DIR = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures"
);

/** Each set is joined by its own protocol's rules, so a set nobody taught this file fails. */
const FIXTURE_SETS = ["claude", "codex", "grok", "opencode"] as const;
type FixtureSet = (typeof FIXTURE_SETS)[number];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * A path separator in every spelling a capture holds one in: plain, JSON-escaped, as the unicode
 * escape of `/`, percent-encoded in either case (once or twice), and the `-` of a CLI's flattened
 * cache dir names (`-var-lib-orquester-…`).
 */
const SEP = String.raw`(?:\\*/|\\+u002f|%(?:25)?2f|-)`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface TextRule {
  name: string;
  pattern: RegExp;
  /** A match that has the shape but is not the thing (prose) is not a finding. */
  counts?: (match: string) => boolean;
}

const TEXT_RULES: readonly TextRule[] = [
  { name: "the build host's home", pattern: new RegExp(`var${SEP}lib${SEP}orquester`, "gi") },
  {
    name: "a managed account's id",
    pattern: new RegExp(`agent-accounts${SEP}[a-z0-9_.]+${SEP}${UUID}`, "gi")
  },
  { name: "an e-mail address", pattern: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi },
  {
    name: "a token",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|ATATT[A-Za-z0-9_=-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g
  },
  {
    // The scheme as HTTP spells it: a lower-case "bearer" is prose.
    name: "a credential",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    // A real-looking value holds a digit or a symbol; "Basic authentication" does not.
    counts: (match) => /[^A-Za-z]/.test(match.replace(/^\S+\s+/, ""))
  }
];

/** A credential-named field: `apiKey`, `GITHUB_TOKEN`, `authorization`, `clientSecret`, … */
function isCredentialKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const last = words.at(-1);
  if (last === "key") {
    return words.at(-2) === "api" || words.at(-2) === "private";
  }
  return (
    last === "apikey" ||
    last === "token" ||
    last === "secret" ||
    last === "password" ||
    last === "passwd" ||
    last === "authorization" ||
    last === "cookie"
  );
}

/** A value a README names as redacted: empty, `<redacted>`-like, or elided. */
const PLACEHOLDER_VALUE = /^(?:|<[^<>]*>|\.\.\.|…)$/;
/** A scheme-prefixed value is the `a credential` text rule's to judge, on the same line. */
const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic)\s/;

/**
 * The placeholders and the deliberate fakes the READMEs document, by the exact text a rule
 * matched. Nothing else is allowed: a finding that is harmless but undocumented is documented in
 * its README first, then listed here.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["user@example.invalid", "the account e-mail's placeholder (the claude and codex READMEs)"],
  [
    "Bearer fixture-password",
    "opencode 01's auth probe: the throwaway `OPENCODE_SERVER_PASSWORD` it ran with (opencode README)"
  ],
  ["Basic b3BlbmNvZGU6Zml4dHVyZS1wYXNzd29yZA==", 'the same probe: base64("opencode:fixture-password")'],
  ["Basic OmZpeHR1cmUtcGFzc3dvcmQ=", 'the same probe: base64(":fixture-password")'],
  ["Basic b3BlbmNvZGU6d3Jvbmc=", 'the same probe\'s wrong credential: base64("opencode:wrong")'],
  [
    '"apiKey":"public"',
    "OpenCode Zen's public key for its free models, verbatim in `/provider` (opencode 01; opencode README)"
  ]
]);

interface Finding {
  where: string;
  rule: string;
  match: string;
}

function scanText(where: string, text: string, findings: Finding[]): void {
  for (const rule of TEXT_RULES) {
    for (const [match] of text.matchAll(rule.pattern)) {
      if (rule.counts !== undefined && !rule.counts(match)) continue;
      findings.push({ where, rule: rule.name, match });
    }
  }
}

/**
 * Walks one parsed value: every credential-named field holding a real value, and every byte
 * array — scanned decoded, since a text rule never sees the path its bytes spell.
 */
function scanValue(where: string, value: unknown, findings: Finding[], redactMcpEnvironment = false): void {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const decoded = Buffer.from(value as number[]).toString("utf8");
      scanText(`${where} (a byte array, decoded)`, decoded, findings);
      return;
    }
    for (const entry of value) scanValue(where, entry, findings, redactMcpEnvironment);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  // Grok's fixture README requires EVERY MCP environment value to be redacted,
  // including host/settings values with neither credential names nor token shapes.
  if (redactMcpEnvironment && Array.isArray(record.mcpServers)) {
    for (const server of record.mcpServers) {
      const env = asRecord(server)?.env;
      if (!Array.isArray(env)) continue;
      for (const entry of env) {
        if (asRecord(entry)?.value !== "<redacted>") {
          findings.push({ where, rule: "an unredacted MCP environment value", match: "mcpServers[].env[].value" });
        }
      }
    }
  }
  // An env entry as Grok's MCP definitions spell one: `{name, value}`.
  if (typeof record.name === "string" && typeof record.value === "string") {
    judgeField(where, record.name, record.value, findings);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") judgeField(where, key, entry, findings);
    else scanValue(where, entry, findings, redactMcpEnvironment);
  }
}

function judgeField(where: string, key: string, value: string, findings: Finding[]): void {
  if (!isCredentialKey(key) || PLACEHOLDER_VALUE.test(value) || AUTH_SCHEME_VALUE.test(value)) return;
  const match = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  findings.push({ where, rule: "a credential-named field", match });
}

// ---------------------------------------------------------------------------
// Reading a set, and joining what its protocol streams
// ---------------------------------------------------------------------------

interface CaptureLine {
  /** 1-based. */
  line: number;
  value: unknown;
}

interface JoinedStream {
  where: string;
  text: string;
}

/** Values streamed in pieces, each joined in arrival order. */
class StreamJoiner {
  private readonly streams = new Map<
    string,
    { label: string; first: number; last: number; parts: string[] }
  >();

  add(key: string, label: string, line: number, piece: string): void {
    const stream = this.streams.get(key);
    if (stream === undefined) {
      this.streams.set(key, { label, first: line, last: line, parts: [piece] });
      return;
    }
    stream.parts.push(piece);
    stream.last = line;
  }

  joined(file: string): JoinedStream[] {
    return [...this.streams.values()].map((stream) => ({
      where: `${file}:${stream.first}-${stream.last} (${stream.label}, joined)`,
      text: stream.parts.join("")
    }));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One streamed content block of a Claude capture. */
interface ClaudeStreamedBlock {
  messageId: string;
  index: number;
  /** Its `content_block_start.content_block`. */
  start: Record<string, unknown>;
  /** By `delta.type`: what its deltas carried, joined. */
  deltas: Map<string, { first: number; last: number; text: string }>;
}

/**
 * Claude streams a block's value as `content_block_delta`s keyed by `index` under the message the
 * last `message_start` opened — indexes restart at 0 with every message (the fixtures README,
 * observation 17) — and each delta carries its piece in one string field (`text`, `thinking`,
 * `signature`, `partial_json`). Beside the blocks: every block of every complete `assistant`
 * frame, by message id.
 */
function readClaudeBlocks(lines: readonly CaptureLine[]): {
  blocks: ClaudeStreamedBlock[];
  complete: Map<string, Record<string, unknown>[]>;
} {
  const blocks = new Map<string, ClaudeStreamedBlock>();
  const complete = new Map<string, Record<string, unknown>[]>();
  const openMessage = new Map<string, string>();
  for (const { line, value } of lines) {
    const record = asRecord(value);
    const data = asRecord(record?.data);
    if (record?.kind !== "sdk-message" || data === undefined) continue;
    if (data.type === "assistant") {
      const message = asRecord(data.message);
      const id = str(message?.id);
      if (id === undefined || !Array.isArray(message?.content)) continue;
      const list = complete.get(id) ?? [];
      for (const block of message.content) {
        const entry = asRecord(block);
        if (entry !== undefined) list.push(entry);
      }
      complete.set(id, list);
      continue;
    }
    const event = asRecord(data.event);
    if (data.type !== "stream_event" || event === undefined) continue;
    const stream = `${String(data.session_id)}|${String(data.parent_tool_use_id)}`;
    if (event.type === "message_start") {
      openMessage.set(stream, str(asRecord(event.message)?.id) ?? `line ${line}`);
      continue;
    }
    const index = event.index;
    if (typeof index !== "number") continue;
    const messageId = openMessage.get(stream) ?? "<no message_start>";
    const key = `${messageId}#${index}`;
    if (event.type === "content_block_start") {
      const start = asRecord(event.content_block) ?? {};
      blocks.set(key, { messageId, index, start, deltas: new Map() });
      continue;
    }
    const delta = asRecord(event.delta);
    if (event.type !== "content_block_delta" || delta === undefined) continue;
    let block = blocks.get(key);
    if (block === undefined) {
      block = { messageId, index, start: {}, deltas: new Map() };
      blocks.set(key, block);
    }
    const type = str(delta.type) ?? "<untyped>";
    for (const [field, piece] of Object.entries(delta)) {
      if (field === "type" || typeof piece !== "string") continue;
      const joined = block.deltas.get(type);
      if (joined === undefined) {
        block.deltas.set(type, { first: line, last: line, text: piece });
      } else {
        joined.text += piece;
        joined.last = line;
      }
    }
  }
  return { blocks: [...blocks.values()], complete };
}

function claudeStreams(file: string, lines: readonly CaptureLine[]): JoinedStream[] {
  return readClaudeBlocks(lines).blocks.flatMap((block) =>
    [...block.deltas].map(([type, joined]) => ({
      where: `${file}:${joined.first}-${joined.last} (${type}, block ${block.messageId}#${block.index}, joined)`,
      text: joined.text
    }))
  );
}

/** Codex streams an item's text as `…/delta` notifications, one per piece, under its `itemId`. */
function codexStreams(file: string, lines: readonly CaptureLine[]): JoinedStream[] {
  const joiner = new StreamJoiner();
  for (const { line, value } of lines) {
    const frame = asRecord(asRecord(value)?.frame);
    const method = str(frame?.method);
    const params = asRecord(frame?.params);
    const piece = str(params?.delta);
    if (method === undefined || !/delta$/i.test(method) || params === undefined || piece === undefined) {
      continue;
    }
    const { delta: _piece, ...identity } = params;
    joiner.add(`${method}|${JSON.stringify(identity)}`, `${method} ${String(params.itemId)}`, line, piece);
  }
  return joiner.joined(file);
}

/** OpenCode streams a part's field as `message.part.delta` events, one per piece. */
function opencodeStreams(file: string, lines: readonly CaptureLine[]): JoinedStream[] {
  const joiner = new StreamJoiner();
  for (const { line, value } of lines) {
    const record = asRecord(value);
    const data = asRecord(record?.data);
    const properties = asRecord(data?.properties);
    const piece = str(properties?.delta);
    if (record?.kind !== "sse" || data?.type !== "message.part.delta" || piece === undefined) continue;
    const part = String(properties?.partID);
    const field = String(properties?.field);
    const key = `${String(properties?.sessionID)}|${String(properties?.messageID)}|${part}|${field}`;
    joiner.add(key, `message.part.delta ${part}.${field}`, line, piece);
  }
  return joiner.joined(file);
}

const GROK_TEXT_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

/**
 * Grok streams a message or a thought as `*_chunk` updates per session and prompt, and a tool
 * call's arguments as `tool_call_delta_chunk`s: a header naming the call and its `tool_index`,
 * then `arguments_delta` pieces naming only the index.
 */
function grokStreams(file: string, lines: readonly CaptureLine[]): JoinedStream[] {
  const joiner = new StreamJoiner();
  const callAtIndex = new Map<string, string>();
  for (const { line, value } of lines) {
    const params = asRecord(asRecord(asRecord(value)?.frame)?.params);
    const update = asRecord(params?.update);
    const kind = str(update?.sessionUpdate);
    if (params === undefined || update === undefined || kind === undefined) continue;
    const session = String(params.sessionId);
    if (GROK_TEXT_CHUNKS.has(kind)) {
      const piece = str(asRecord(update.content)?.text);
      if (piece === undefined) continue;
      const prompt = String(asRecord(params._meta)?.promptId ?? "");
      joiner.add(`${session}|${kind}|${prompt}`, `${kind}, session ${session}`, line, piece);
    } else if (kind === "tool_call_delta_chunk") {
      const slot = `${session}|${String(update.tool_index)}`;
      const call = str(update.tool_call_id);
      if (call !== undefined) callAtIndex.set(slot, call);
      const piece = str(update.arguments_delta);
      if (piece === undefined) continue;
      const id = callAtIndex.get(slot) ?? `index ${String(update.tool_index)}`;
      joiner.add(`${session}|${id}`, `tool_call_delta_chunk ${id}`, line, piece);
    }
  }
  return joiner.joined(file);
}

const JOINERS: Record<FixtureSet, (file: string, lines: readonly CaptureLine[]) => JoinedStream[]> = {
  claude: claudeStreams,
  codex: codexStreams,
  grok: grokStreams,
  opencode: opencodeStreams
};

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Every capture file of a set, its READMEs excepted, as paths relative to the set. */
function captureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? captureFiles(nodePath.join(dir, entry.name)).map((name) => nodePath.join(entry.name, name))
        : [entry.name]
    )
    .filter((name) => !name.endsWith(".md"))
    .sort();
}

function parseJson(where: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${where} is not one JSON value`);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A `.ndjson` capture's lines, parsed. */
function readCaptureLines(file: string, content: string): CaptureLine[] {
  return content
    .split("\n")
    .flatMap((row, at) => (row.length > 0 ? [{ line: at + 1, value: parseJson(`${file}:${at + 1}`, row) }] : []));
}

/**
 * Every match in one set, the allowed ones included: each line of each file as written, each
 * value an `.ndjson` line or a `.json` file parses to (its credential-named fields, its byte
 * arrays decoded), and each value the set's protocol streamed, joined.
 */
function scanSet(set: FixtureSet): Finding[] {
  const findings: Finding[] = [];
  const dir = nodePath.join(FIXTURES_DIR, set);
  for (const name of captureFiles(dir)) {
    const file = `${set}/${name}`;
    const content = readFileSync(nodePath.join(dir, name), "utf8");
    content.split("\n").forEach((row, at) => scanText(`${file}:${at + 1}`, row, findings));
    if (name.endsWith(".json")) {
      scanValue(file, parseJson(file, content), findings, set === "grok");
    }
    if (!name.endsWith(".ndjson")) continue;
    const lines = readCaptureLines(file, content);
    for (const { line, value } of lines) scanValue(`${file}:${line}`, value, findings, set === "grok");
    for (const stream of JOINERS[set](file, lines)) {
      scanText(stream.where, stream.text, findings);
      const value = tryParseJson(stream.text);
      if (value !== undefined) scanValue(stream.where, value, findings, set === "grok");
    }
  }
  return findings;
}

/** One row per place and value, counted: an account path repeats a dozen times in one frame. */
function listFindings(set: FixtureSet, findings: readonly Finding[]): string {
  const counted = new Map<string, number>();
  for (const finding of findings) {
    const row = `  ${finding.where}: ${finding.rule}: ${finding.match}`;
    counted.set(row, (counted.get(row) ?? 0) + 1);
  }
  const rows = [...counted].map(([row, count]) => (count > 1 ? `${row} (×${count})` : row));
  const shown = rows.slice(0, 60);
  const more = rows.length > shown.length ? [`  … and ${rows.length - shown.length} more places`] : [];
  return [`${findings.length} host-identifying value(s) in the ${set} fixtures:`, ...shown, ...more].join("\n");
}

/**
 * `undefined` when a streamed Claude block joins to what its complete frame holds, or when there
 * is nothing to compare: a block the CLI never completed, and a tool input it did not stream at
 * all (`09`'s `ExitPlanMode`: one empty `partial_json`, the whole input on the complete frame).
 * Otherwise, what differs. A redaction applied to the complete frames and not to the stream —
 * whatever its rule — shows here, shape or no shape.
 */
function joinsToCompleteFrame(
  type: string,
  start: Record<string, unknown>,
  joined: string,
  frames: readonly Record<string, unknown>[]
): string | undefined {
  const excerpt = (text: string): string =>
    JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text);
  switch (type) {
    case "input_json_delta": {
      const frame = frames.find((candidate) => candidate.id !== undefined && candidate.id === start.id);
      if (frame === undefined || joined.length === 0) return undefined;
      return isDeepStrictEqual(tryParseJson(joined), frame.input)
        ? undefined
        : `joins to ${excerpt(joined)}, its complete frame holds ${excerpt(JSON.stringify(frame.input))}`;
    }
    case "text_delta":
    case "thinking_delta":
    case "signature_delta": {
      const blockType = type === "text_delta" ? "text" : "thinking";
      const field = type === "text_delta" ? "text" : type === "thinking_delta" ? "thinking" : "signature";
      const candidates = frames.filter((candidate) => candidate.type === blockType);
      const value = `${type === "signature_delta" ? "" : (str(start[field]) ?? "")}${joined}`;
      if (candidates.length === 0 || candidates.some((candidate) => candidate[field] === value)) {
        return undefined;
      }
      return `joins to ${excerpt(value)}, and no ${blockType} block of its message holds that`;
    }
    default:
      return undefined;
  }
}

describe("the protocol fixtures' redaction post-check", () => {
  it("covers every fixture set", () => {
    const sets = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(sets, [...FIXTURE_SETS]);
  });

  for (const set of FIXTURE_SETS) {
    it(`${set}: no line, decoded byte array or joined stream holds a host-identifying value`, () => {
      const findings = scanSet(set).filter((finding) => !ALLOWED.has(finding.match));
      assert.equal(findings.length, 0, listFindings(set, findings));
    });
  }

  it("claude: every streamed block joins to what its complete frame holds", () => {
    const mismatches: string[] = [];
    const dir = nodePath.join(FIXTURES_DIR, "claude");
    for (const name of captureFiles(dir).filter((file) => file.endsWith(".ndjson"))) {
      const file = `claude/${name}`;
      const { blocks, complete } = readClaudeBlocks(
        readCaptureLines(file, readFileSync(nodePath.join(dir, name), "utf8"))
      );
      for (const block of blocks) {
        const frames = complete.get(block.messageId) ?? [];
        for (const [type, joined] of block.deltas) {
          const verdict = joinsToCompleteFrame(type, block.start, joined.text, frames);
          if (verdict === undefined) continue;
          const where = `${file}:${joined.first}-${joined.last} (${type}, block ${block.messageId}#${block.index})`;
          mismatches.push(`  ${where}: ${verdict}`);
        }
      }
    }
    assert.deepEqual(mismatches, [], `a streamed block its complete frame disagrees with:\n${mismatches.join("\n")}`);
  });
});
