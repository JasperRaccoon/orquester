/**
 * Config sync — how a host file becomes its box copy and back (`SyncCodecId` in `rules.ts`).
 *
 * Every codec defines two *views*: `hostView(host)` is what the box copy must be equal to, and
 * `boxView(box)` is the box copy seen the same way. The two sides are in sync exactly when the
 * views are byte-equal, and the sync baseline stores the SHA-256 of that view — so a host write
 * that does not touch what syncs (Claude rewriting `.claude.json` state) is not a change, and a
 * pending box change is only stale when the host's view moved.
 *
 * **Secrets.** MCP server env and header values and credential-named keys (`apiKey`,
 * `GITHUB_TOKEN`, `experimental_bearer_token`, …) are blanked to `""` in the box copy (spec §2:
 * no secret on disk in a box; MCP servers run on the host by default, §8.4). Approving a box
 * edit restores every value the box left blank from the host file, so an agent that adds a key
 * next to a secret never wipes the secret. A config that does not parse cannot be checked for
 * secrets and does not sync (its `hostView` is null).
 *
 * Formatting: JSON(C) and TOML edits go through `jsonc-parser`'s `modify` and the Agent config
 * TOML editor (`editToml`), so comments and layout survive on both sides.
 */

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import { boxToHostPath, hostToBoxPath, type BoxPathMap } from "@orquester/api";

import { editToml, parseToml, type TomlEdit } from "../../agent-profile/adapters/grok/toml-patch.ts";
import type { ConfigKeyPattern, SyncCodecId } from "./rules.ts";

export interface CodecContext {
  /** The box's path mapping (Claude's `.claude.json` keys projects by box path). */
  paths: BoxPathMap;
}

export interface SyncCodec {
  /** What the box copy must equal; null = the host file cannot be synced (unparseable config). */
  hostView(host: Buffer, ctx: CodecContext): Buffer | null;
  boxView(box: Buffer, ctx: CodecContext): Buffer;
  /** The bytes to write into the box, given its current copy (null = none). Null = do not write. */
  toBox(host: Buffer, box: Buffer | null, ctx: CodecContext): Buffer | null;
  /** The host bytes after approving the box's copy (null host = the file is new on the host). */
  toHost(box: Buffer, host: Buffer | null, ctx: CodecContext): Buffer;
  /**
   * Whether keys that start processes or redirect credentials (`keys`, from
   * `executableConfigKeys`) differ between two views — or what a blanked secret would be restored
   * next to (its server's command or URL, a provider's base URL…).
   */
  executableKeysChanged(hostView: Buffer | null, boxView: Buffer | null, keys: readonly ConfigKeyPattern[]): boolean;
}

type Doc = Record<string, unknown>;
type KeyPath = string[];

const isPlainObject = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

const SECRET_KEY = /secret|passw(or)?d|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?$|authorization|bearer|token$|cookie/i;
/** Keys that NAME a secret (an env var, a helper command, a file) rather than hold one. */
const NOT_SECRET_KEY = /(env_?var|env_?key|_env|command|helper|path|file|url|uri|dir|name|_?id)$/i;
const MCP_PARENTS = new Set(["mcpServers", "mcp_servers", "mcp"]);
const MCP_SECRET_TABLES = new Set(["env", "environment", "headers", "http_headers"]);

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key);
}

/** `…mcpServers.<name>.env.<KEY>` and its TOML / OpenCode spellings. */
function inMcpSecretTable(path: readonly string[]): boolean {
  return path.length >= 4 && MCP_SECRET_TABLES.has(path[path.length - 2]!) && MCP_PARENTS.has(path[path.length - 4]!);
}

/** Paths of every string value at a secret's place, non-empty ones or (`blank`) empty ones; arrays are not entered. */
function secretLeafPaths(doc: unknown, blank: boolean, prefix: KeyPath = []): KeyPath[] {
  const out: KeyPath[] = [];
  if (!isPlainObject(doc)) return out;
  for (const [key, value] of Object.entries(doc)) {
    const path = [...prefix, key];
    if (typeof value === "string") {
      if ((value.length === 0) === blank &&(inMcpSecretTable(path) || isSecretKey(key))) out.push(path);
    } else if (isPlainObject(value)) {
      out.push(...secretLeafPaths(value, blank, path));
    }
  }
  return out;
}

/** Paths of every non-empty string value that is a secret (objects only; arrays are not entered). */
export function secretPaths(doc: unknown, prefix: KeyPath = []): KeyPath[] {
  return secretLeafPaths(doc, false, prefix);
}

function getPath(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const segment of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Keys that decide where a secret goes or what receives it: an MCP server's command, arguments,
 * transport and URL; a provider's base URL or endpoint; hosts and proxies; env that loads code.
 */
const SECRET_TARGET_KEY = /^(command|args|cwd|type|transport|node_options|ld_preload|dyld_insert_libraries)$|(url|uri|endpoint|proxy)$|(^|[_-])host$/i;

/** The objects whose target keys decide where the secret at `path` goes: its own, and the MCP server it belongs to. */
function secretOwners(path: KeyPath): KeyPath[] {
  const owners = [path.slice(0, -1)];
  if (inMcpSecretTable(path)) owners.push(path.slice(0, -2));
  return owners;
}

/**
 * Whether a target key next to the secret at `path` differs between `host` and `box`. A box value
 * left blank where the host has a secret (`hostSecrets`) is no difference: it is restored too.
 */
function secretTargetChanged(host: Doc, box: Doc, path: KeyPath, hostSecrets: ReadonlySet<string>): boolean {
  for (const owner of secretOwners(path)) {
    const hostNode = owner.length === 0 ? host : getPath(host, owner);
    const boxNode = owner.length === 0 ? box : getPath(box, owner);
    const hostObject = isPlainObject(hostNode) ? hostNode : {};
    const boxObject = isPlainObject(boxNode) ? boxNode : {};
    for (const key of new Set([...Object.keys(hostObject), ...Object.keys(boxObject)])) {
      if (!SECRET_TARGET_KEY.test(key)) continue;
      if (boxObject[key] === "" && hostSecrets.has(JSON.stringify([...owner, key]))) continue;
      if (canonicalJson(hostObject[key] ?? null) !== canonicalJson(boxObject[key] ?? null)) return true;
    }
  }
  return false;
}

/** Whether, between two views (secrets blanked in both), a blanked secret's targets moved. */
function blankedSecretTargetsChanged(hostView: Doc | null, boxView: Doc | null): boolean {
  if (hostView === null || boxView === null) return false;
  return secretLeafPaths(hostView, true).some((path) => getPath(boxView, path) === "" && secretTargetChanged(hostView, boxView, path, new Set()));
}

/** Every value of `doc` at a path matching `pattern`, keyed by that path. */
function valuesAt(doc: unknown, pattern: ConfigKeyPattern): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (node: unknown, index: number, path: string[]): void => {
    if (index === pattern.length) {
      out[JSON.stringify(path)] = node;
      return;
    }
    if (!isPlainObject(node)) return;
    const segment = pattern[index]!;
    for (const key of Object.keys(node)) {
      if (segment === "*" || (typeof segment === "string" ? key === segment : segment.test(key))) visit(node[key], index + 1, [...path, key]);
    }
  };
  visit(doc, 0, []);
  return out;
}

function executableKeysDiffer(a: Doc | null, b: Doc | null, keys: readonly ConfigKeyPattern[]): boolean {
  return keys.some((pattern) => canonicalJson(valuesAt(a, pattern)) !== canonicalJson(valuesAt(b, pattern)));
}

// ---------------------------------------------------------------------------
// JSON(C) and TOML helpers
// ---------------------------------------------------------------------------

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

function parseJsonDoc(text: string): Doc | null {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isPlainObject(value)) return null;
  return value;
}

/** Set (or, with `undefined`, delete) each path in turn, keeping the rest of the text. */
function editJson(text: string, edits: readonly { path: KeyPath; value: unknown }[]): string {
  let current = text;
  for (const edit of edits) {
    current = applyEdits(current, modify(current, edit.path, edit.value, JSON_FORMAT));
  }
  return current;
}

function parseTomlDoc(text: string): Doc | null {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

/** Sorted keys, 2-space indent, trailing newline: one spelling per value. */
export function canonicalJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (isPlainObject(node)) {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    }
    return node;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

const rawCodec: SyncCodec = {
  hostView: (host) => host,
  boxView: (box) => box,
  toBox: (host) => host,
  toHost: (box) => box,
  executableKeysChanged: () => false
};

interface StructuredFormat {
  parse(text: string): Doc | null;
  /** Set each path to its value in `text`. */
  edit(text: string, edits: readonly { path: KeyPath; value: unknown }[]): string;
}

const jsonFormat: StructuredFormat = { parse: parseJsonDoc, edit: editJson };

const tomlFormat: StructuredFormat = {
  parse: parseTomlDoc,
  edit: (text, edits) => editToml(text, edits.map((edit): TomlEdit => ({ op: "set", path: edit.path, value: edit.value })))
};

/** `text` with every secret blanked; null when it does not parse. */
function redactText(format: StructuredFormat, text: string): string | null {
  const doc = format.parse(text);
  if (doc === null) return null;
  const paths = secretPaths(doc);
  return paths.length === 0 ? text : format.edit(text, paths.map((path) => ({ path, value: "" })));
}

/**
 * The box's text with every value it left blank restored from the host's text — except a secret
 * whose targets the box changed (its server's command or URL, a provider's base URL, a host or
 * proxy next to it): restoring that would hand the secret to whatever the box pointed it at, so
 * it stays blank.
 */
function restoreText(format: StructuredFormat, boxText: string, hostText: string | null): string {
  const hostDoc = hostText === null ? null : format.parse(hostText);
  const boxDoc = format.parse(boxText);
  if (hostDoc === null || boxDoc === null) return boxText;
  const secrets = secretPaths(hostDoc);
  const hostSecrets = new Set(secrets.map((path) => JSON.stringify(path)));
  const edits = secrets
    .filter((path) => getPath(boxDoc, path) === "" && !secretTargetChanged(hostDoc, boxDoc, path, hostSecrets))
    .map((path) => ({ path, value: getPath(hostDoc, path) }));
  return edits.length === 0 ? boxText : format.edit(boxText, edits);
}

function redactingCodec(format: StructuredFormat): SyncCodec {
  const view = (host: Buffer): Buffer | null => {
    const text = redactText(format, host.toString("utf8"));
    return text === null ? null : Buffer.from(text, "utf8");
  };
  return {
    hostView: view,
    boxView: (box) => box,
    toBox: (host) => view(host),
    toHost: (box, host) => Buffer.from(restoreText(format, box.toString("utf8"), host?.toString("utf8") ?? null), "utf8"),
    executableKeysChanged: (hostView, boxView, keys) => {
      const a = hostView === null ? null : format.parse(hostView.toString("utf8"));
      const b = boxView === null ? null : format.parse(boxView.toString("utf8"));
      return executableKeysDiffer(a, b, keys) || blankedSecretTargetsChanged(a, b);
    }
  };
}

/** The per-project `.claude.json` keys that sync: MCP servers, `.mcp.json` approvals, trust, allowed tools. */
export const CLAUDE_JSON_PROJECT_KEYS = ["mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "hasTrustDialogAccepted", "allowedTools"];

interface ClaudeSubset {
  mcpServers?: unknown;
  projects: Record<string, Doc>;
}

/** The synced part of a `.claude.json`, with project keys passed through `mapKey` (null = drop). */
function claudeSubset(doc: Doc | null, mapKey: (key: string) => string | null): ClaudeSubset {
  const subset: ClaudeSubset = { projects: {} };
  if (doc === null) return subset;
  if (Object.hasOwn(doc, "mcpServers")) subset.mcpServers = doc.mcpServers;
  const projects = doc.projects;
  if (isPlainObject(projects)) {
    for (const [key, project] of Object.entries(projects)) {
      if (!isPlainObject(project)) continue;
      const mapped = mapKey(key);
      if (mapped === null) continue;
      const kept: Doc = {};
      for (const name of CLAUDE_JSON_PROJECT_KEYS) {
        if (Object.hasOwn(project, name)) kept[name] = project[name];
      }
      if (Object.keys(kept).length > 0) subset.projects[mapped] = kept;
    }
  }
  return subset;
}

function claudeSubsetDoc(subset: ClaudeSubset): Doc {
  const doc: Doc = {};
  if (subset.mcpServers !== undefined) doc.mcpServers = subset.mcpServers;
  if (Object.keys(subset.projects).length > 0) doc.projects = subset.projects;
  return doc;
}

/** Edits that make the subset of `text` equal `subset` (keys absent from `subset` are deleted). */
function claudeSubsetEdits(current: ClaudeSubset, subset: ClaudeSubset): { path: KeyPath; value: unknown }[] {
  const edits: { path: KeyPath; value: unknown }[] = [];
  if (canonicalJson(current.mcpServers ?? null) !== canonicalJson(subset.mcpServers ?? null)) {
    edits.push({ path: ["mcpServers"], value: subset.mcpServers });
  }
  const projectKeys = new Set([...Object.keys(current.projects), ...Object.keys(subset.projects)]);
  for (const project of projectKeys) {
    for (const name of CLAUDE_JSON_PROJECT_KEYS) {
      const want = subset.projects[project]?.[name];
      const have = current.projects[project]?.[name];
      if (canonicalJson(want ?? null) !== canonicalJson(have ?? null) || (want === undefined) !== (have === undefined)) {
        edits.push({ path: ["projects", project, name], value: want });
      }
    }
  }
  return edits;
}

/** Host project keys (absolute host paths) as the box CLI spells them; anything else stays out. */
const hostKeyToBox =
  (ctx: CodecContext) =>
  (key: string): string | null =>
    key.startsWith("/") ? hostToBoxPath(ctx.paths, key) : null;

const claudeJsonCodec: SyncCodec = {
  hostView(host, ctx) {
    const redacted = redactText(jsonFormat, host.toString("utf8"));
    if (redacted === null) return null;
    const subset = claudeSubset(parseJsonDoc(redacted), hostKeyToBox(ctx));
    return Buffer.from(canonicalJson(claudeSubsetDoc(subset)), "utf8");
  },
  boxView(box, ctx) {
    const subset = claudeSubset(parseJsonDoc(box.toString("utf8")), (key) => (boxToHostPath(ctx.paths, key) === null ? null : key));
    return Buffer.from(canonicalJson(claudeSubsetDoc(subset)), "utf8");
  },
  toBox(host, box, ctx) {
    const redacted = redactText(jsonFormat, host.toString("utf8"));
    if (redacted === null) return null;
    const want = claudeSubset(parseJsonDoc(redacted), hostKeyToBox(ctx));
    // The box CLI's own state is kept; a missing or unreadable file starts from a finished onboarding.
    const boxText = box?.toString("utf8") ?? "";
    const base = parseJsonDoc(boxText) === null ? `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n` : boxText;
    const edits = claudeSubsetEdits(claudeSubset(parseJsonDoc(base), (key) => (boxToHostPath(ctx.paths, key) === null ? null : key)), want);
    return Buffer.from(edits.length === 0 ? base : editJson(base, edits), "utf8");
  },
  toHost(box, host, ctx) {
    const hostText = host?.toString("utf8") ?? "{}\n";
    const hostDoc = parseJsonDoc(hostText);
    const boxDoc = parseJsonDoc(box.toString("utf8"));
    if (hostDoc === null || boxDoc === null) return host ?? Buffer.from(hostText, "utf8");
    const hostSubset = claudeSubset(hostDoc, (key) => key);
    const boxSubset = claudeSubset(boxDoc, (key) => boxToHostPath(ctx.paths, key));
    // Restore what the box left blank, in subset coordinates (project keys are host paths in both).
    const restored = parseJsonDoc(
      restoreText(jsonFormat, JSON.stringify(claudeSubsetDoc(boxSubset)), JSON.stringify(claudeSubsetDoc(hostSubset)))
    );
    const next = claudeSubset(restored, (key) => key);
    const edits = claudeSubsetEdits(hostSubset, next);
    return edits.length === 0 ? (host ?? Buffer.from(hostText, "utf8")) : Buffer.from(editJson(hostText, edits), "utf8");
  },
  executableKeysChanged(hostView, boxView, keys) {
    // Both views are the synced subset, project keys spelled as the box does.
    const a = hostView === null ? null : parseJsonDoc(hostView.toString("utf8"));
    const b = boxView === null ? null : parseJsonDoc(boxView.toString("utf8"));
    return executableKeysDiffer(a, b, keys) || blankedSecretTargetsChanged(a, b);
  }
};

const CODECS: Readonly<Record<SyncCodecId, SyncCodec>> = {
  raw: rawCodec,
  "mcp-json": redactingCodec(jsonFormat),
  "mcp-toml": redactingCodec(tomlFormat),
  "claude-json": claudeJsonCodec
};

export function syncCodec(id: SyncCodecId): SyncCodec {
  return CODECS[id];
}
