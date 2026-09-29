/**
 * Codex hooks (spec §4.6 Codex): `<CODEX_HOME>/hooks.json` and its
 * `[hooks.state."<key>"]` entries in `config.toml`.
 *
 * `hooks.json` is `{hooks: {Event: [{matcher?, hooks: [{type, command,
 * timeout?, statusMessage?, async?}]}]}}`. Codex parses it with
 * `deny_unknown_fields`, so a handler this module writes carries only those
 * fields; everything already in the file is kept as it is.
 *
 * A handler's state key is POSITIONAL and embeds the `hooks.json` path as
 * Codex opened it: `<path>:<event_snake>:<groupIndex>:<handlerIndex>`. Every
 * managed account home symlinks its `hooks.json` to the system one, so one
 * hook has one key per path it is seen from, all in the one shared
 * `config.toml`. Its `trusted_hash` is Codex's `command_hook_hash` of the
 * handler (see {@link codexHookHash}); a hook runs only when its current hash
 * equals the stored one.
 *
 * Inserting or removing a group or handler moves the positions of the ones
 * after it, so after every such edit {@link rekeyHookState} moves each state
 * entry to the new key of the handler its `trusted_hash` matches (falling back
 * to where the edit itself moved that position), and drops the entries whose
 * handler is gone.
 */

import { createHash } from "node:crypto";
import { isManagedGroup } from "../../../agent-hooks.ts";
import { hookItemId } from "../../infra/index.ts";

/** A handler as `hooks.json` holds it; unknown fields of an existing handler are kept verbatim. */
export interface CodexHookHandler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  statusMessage?: unknown;
  async?: unknown;
  [field: string]: unknown;
}

export interface CodexHookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [field: string]: unknown;
}

/** The whole file; keys other than `hooks` are kept. */
export interface CodexHooksDocument {
  hooks: Record<string, CodexHookGroup[]>;
  [field: string]: unknown;
}

/** One handler at its position. */
export interface CodexHookEntry {
  /** The event as `hooks.json` spells it (`PreToolUse`). */
  event: string;
  /** `pre_tool_use` — the state key's spelling. */
  eventSnake: string;
  groupIndex: number;
  handlerIndex: number;
  matcher?: string;
  handler: CodexHookHandler;
  /** In an Orquester-managed group (`agent-hook.sh`): locked. */
  managed: boolean;
}

/** The empty document written when `hooks.json` does not exist yet. */
export function emptyHooksDocument(): CodexHooksDocument {
  return { hooks: {} };
}

/**
 * Parses `hooks.json` strictly enough to edit it safely: the top level must be
 * an object, `hooks` (when present) an object of arrays of objects. Throws an
 * `Error` naming the problem otherwise (the snapshot reports it; writes refuse).
 */
export function parseHooksDocument(text: string): CodexHooksDocument {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("hooks.json must hold a JSON object.");
  }
  const hooks = parsed.hooks ?? {};
  if (!isRecord(hooks)) {
    throw new Error('"hooks" must be an object of event names.');
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || !groups.every(isRecord)) {
      throw new Error(`"hooks.${event}" must be a list of matcher groups.`);
    }
    for (const group of groups as CodexHookGroup[]) {
      if (group.hooks !== undefined && (!Array.isArray(group.hooks) || !group.hooks.every(isRecord))) {
        throw new Error(`A "hooks.${event}" group's "hooks" must be a list of handlers.`);
      }
    }
  }
  return { ...parsed, hooks: hooks as Record<string, CodexHookGroup[]> };
}

export function serializeHooksDocument(doc: CodexHooksDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** `PreToolUse` → `pre_tool_use`. */
export function eventSnake(event: string): string {
  return event
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function groupHandlers(group: CodexHookGroup): CodexHookHandler[] {
  return Array.isArray(group.hooks) ? (group.hooks as CodexHookHandler[]) : [];
}

/** Every handler in document order (events in key order, then groups, then handlers). */
export function listHookEntries(doc: CodexHooksDocument): CodexHookEntry[] {
  const entries: CodexHookEntry[] = [];
  for (const [event, groups] of Object.entries(doc.hooks)) {
    groups.forEach((group, groupIndex) => {
      const managed = isManagedGroup(group);
      groupHandlers(group).forEach((handler, handlerIndex) => {
        entries.push({
          event,
          eventSnake: eventSnake(event),
          groupIndex,
          handlerIndex,
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
          handler,
          managed
        });
      });
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Identity and trust
// ---------------------------------------------------------------------------

/** Events whose matcher Codex drops (it reports `matcher: null` and hashes without it). */
const MATCHERLESS_EVENTS = new Set(["user_prompt_submit", "stop", "interrupt"]);
/** Events Codex gives a 1 s default timeout and clamps to 3 s. */
const SHORT_TIMEOUT_EVENTS = new Set(["session_end", "interrupt"]);
const DEFAULT_TIMEOUT_SEC = 600;
const SHORT_TIMEOUT_DEFAULT_SEC = 1;
const SHORT_TIMEOUT_MAX_SEC = 3;

/** Recursively sorted keys (Codex's canonical JSON); arrays keep their order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/** The timeout Codex runs (and hashes) a handler with. */
function effectiveTimeoutSec(snake: string, timeout: unknown): number {
  const short = SHORT_TIMEOUT_EVENTS.has(snake);
  let value = typeof timeout === "number" && Number.isFinite(timeout) ? Math.floor(timeout) : undefined;
  if (value === undefined) {
    value = short ? SHORT_TIMEOUT_DEFAULT_SEC : DEFAULT_TIMEOUT_SEC;
  }
  value = Math.max(1, value);
  return short ? Math.min(SHORT_TIMEOUT_MAX_SEC, value) : value;
}

/**
 * Codex 0.155.1's `command_hook_hash` of one command handler:
 * `sha256:` + sha256 of the canonical JSON of
 * `{event_name, hooks: [{type: "command", command, timeout, async, statusMessage?}], matcher?}`
 * where `timeout` is the effective one (default 600 s; `session_end` and
 * `interrupt` default 1 s, clamped to 3 s; never below 1), `async` defaults to
 * false, `statusMessage` is present only when set, and the matcher is dropped
 * for `user_prompt_submit`, `stop` and `interrupt`. Verified against
 * `hooks/list`'s `currentHash` of the installed binary for every event and
 * those variations; for the managed handlers (timeout 10, no status message)
 * it equals `agent-hooks.ts`'s `codexTrustHash`. `null` for a handler that is
 * not a command (Codex skips those).
 */
export function codexHookHash(snake: string, handler: CodexHookHandler, matcher: string | undefined): string | null {
  if (handler.type !== "command" || typeof handler.command !== "string") {
    return null;
  }
  const normalized: Record<string, unknown> = {
    type: "command",
    command: handler.command,
    timeout: effectiveTimeoutSec(snake, handler.timeout),
    async: handler.async === true
  };
  if (typeof handler.statusMessage === "string") {
    normalized.statusMessage = handler.statusMessage;
  }
  const identity: Record<string, unknown> = { event_name: snake, hooks: [normalized] };
  if (matcher !== undefined && !MATCHERLESS_EVENTS.has(snake)) {
    identity.matcher = matcher;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex")}`;
}

/** The fields a hook item's id hashes (spec §4.3): matcher plus the handler as written. */
export function hookIdentity(entry: Pick<CodexHookEntry, "matcher" | "handler">): Record<string, unknown> {
  return { matcher: entry.matcher ?? null, ...entry.handler };
}

/**
 * Item ids for every entry, in order. Two identical handlers in one event
 * would share an id, so the second and later ones hash an occurrence counter
 * too (stable while the file does not change around them).
 */
export function hookEntryIds(entries: readonly CodexHookEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = hookItemId(entry.event, hookIdentity(entry));
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : hookItemId(entry.event, { ...hookIdentity(entry), occurrence: count });
  });
}

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

/** A position a state key names. */
export interface HookPosition {
  eventSnake: string;
  groupIndex: number;
  handlerIndex: number;
}

export function stateKey(hooksPath: string, position: HookPosition): string {
  return `${hooksPath}:${position.eventSnake}:${position.groupIndex}:${position.handlerIndex}`;
}

/** Splits a state key from the right (the path itself may hold `:`); `null` when it is not one. */
export function parseStateKey(key: string): ({ path: string } & HookPosition) | null {
  const match = /^(.*):([a-z0-9_]+):(\d+):(\d+)$/.exec(key);
  if (match === null) {
    return null;
  }
  return {
    path: match[1],
    eventSnake: match[2],
    groupIndex: Number(match[3]),
    handlerIndex: Number(match[4])
  };
}

function positionId(position: HookPosition): string {
  return `${position.eventSnake}:${position.groupIndex}:${position.handlerIndex}`;
}

/** A `[hooks.state."<key>"]` table: `enabled`, `trusted_hash`, and anything else kept. */
export type HookStateEntry = Record<string, unknown>;

export interface RekeyInput {
  /** The handlers before the edit and after it. */
  before: readonly CodexHookEntry[];
  after: readonly CodexHookEntry[];
  /**
   * Where the edit itself moved each old position (`positionId` of before →
   * position after); an old position missing from the map was removed.
   */
  moved: ReadonlyMap<string, HookPosition>;
  /** Every `hooks.state` entry now in `config.toml`, by key. */
  state: Readonly<Record<string, HookStateEntry>>;
  /** Every path the hooks file is seen from (the system one first). */
  paths: readonly string[];
  /** State to set at a position after the edit, for every path (a new or edited hook); merged over what moved there. */
  set?: ReadonlyArray<{ position: HookPosition; entry: HookStateEntry }>;
}

/** What `hooks.state` should become for the given paths: keys to write and keys to delete. */
export interface RekeyResult {
  /** Key → full entry to write (only keys whose entry changed). */
  write: Map<string, HookStateEntry>;
  /** Keys to delete. */
  remove: Set<string>;
}

/**
 * The re-keying (spec §4.6). Every state entry under one of `paths` moves to
 * a handler after the edit, decided in three passes so an entry stays with
 * its own handler whenever it can:
 *
 *  1. the position the edit moved its old position to, when that handler's
 *     hash equals the entry's `trusted_hash` (or the entry has none);
 *  2. otherwise the first unclaimed handler of the same event whose hash
 *     equals its `trusted_hash` (repairs an entry that was already mis-keyed);
 *  3. otherwise the position the edit moved it to, if still unclaimed (a
 *     `modified` hook keeps its stale trust and its on/off state);
 *
 * and is dropped when none applies (its handler is gone). Entries under other
 * paths are left alone. `set` then overrides positions for every path.
 */
export function rekeyHookState(input: RekeyInput): RekeyResult {
  const hashesAfter = new Map<string, string | null>();
  for (const entry of input.after) {
    hashesAfter.set(positionId(entry), codexHookHash(entry.eventSnake, entry.handler, entry.matcher));
  }
  const pathSet = new Set(input.paths);
  const desired = new Map<string, HookStateEntry>();
  const touched = new Set<string>();

  interface Pending {
    key: string;
    path: string;
    eventSnake: string;
    entry: HookStateEntry;
    trusted: string | null;
    structural: HookPosition | undefined;
  }
  const pending: Pending[] = [];
  // Deterministic: entries in key order.
  for (const key of Object.keys(input.state).sort()) {
    const parsed = parseStateKey(key);
    if (parsed === null || !pathSet.has(parsed.path)) {
      continue;
    }
    touched.add(key);
    const entry = input.state[key];
    pending.push({
      key,
      path: parsed.path,
      eventSnake: parsed.eventSnake,
      entry,
      trusted: typeof entry.trusted_hash === "string" ? entry.trusted_hash : null,
      structural: input.moved.get(positionId(parsed))
    });
  }
  const claim = (item: Pending, position: HookPosition): boolean => {
    const key = stateKey(item.path, position);
    if (desired.has(key)) {
      return false;
    }
    desired.set(key, item.entry);
    return true;
  };

  const rest1 = pending.filter((item) => {
    const s = item.structural;
    if (s !== undefined && (item.trusted === null || hashesAfter.get(positionId(s)) === item.trusted)) {
      return !claim(item, s);
    }
    return true;
  });
  const rest2 = rest1.filter((item) => {
    if (item.trusted === null) {
      return true;
    }
    for (const candidate of input.after) {
      if (
        candidate.eventSnake === item.eventSnake &&
        hashesAfter.get(positionId(candidate)) === item.trusted &&
        claim(item, candidate)
      ) {
        return false;
      }
    }
    return true;
  });
  for (const item of rest2) {
    if (item.structural !== undefined) {
      claim(item, item.structural);
    }
  }

  for (const { position, entry } of input.set ?? []) {
    for (const path of input.paths) {
      const key = stateKey(path, position);
      desired.set(key, { ...(desired.get(key) ?? {}), ...entry });
    }
  }

  const write = new Map<string, HookStateEntry>();
  const remove = new Set<string>();
  for (const key of touched) {
    if (!desired.has(key)) {
      remove.add(key);
    }
  }
  for (const [key, entry] of desired) {
    const current = input.state[key];
    if (current === undefined || JSON.stringify(canonicalize(current)) !== JSON.stringify(canonicalize(entry))) {
      write.set(key, entry);
    }
  }
  return { write, remove };
}

export { positionId as hookPositionId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
