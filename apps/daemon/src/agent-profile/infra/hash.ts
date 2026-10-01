/**
 * Agent profile — content hashes and item ids (spec §4.3).
 *
 * Ids are derived from content, never from positions: `<kind>:<name>` for
 * named items and `hook:<event>:<16 hex>` for hooks, whose only identity is
 * what they run. Revisions are content hashes too — of an item's own content
 * and on/off state — so a stale edit is caught without a per-agent counter.
 */

import { createHash } from "node:crypto";
import { type ProfileItemKind, isProfileItemKind } from "@orquester/api";

/**
 * Hex characters kept from a sha256 for revisions and hook ids: 64 bits, far
 * past what a per-item conflict check or a handful of hooks per event can
 * collide on, and short enough to read in a URL.
 */
const PROFILE_HASH_LENGTH = 16;

/**
 * `JSON.stringify` with every object's keys sorted, recursively — the same
 * value always serializes to the same text whatever order its keys were
 * written in. Follows JSON's own rules otherwise: `undefined`, functions and
 * symbols vanish from objects and become `null` in arrays, non-finite numbers
 * become `null`, and a `toJSON()` (a `Date`) is honoured.
 */
export function stableStringify(value: unknown): string {
  return serialize(value) ?? "null";
}

function serialize(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return serialize((value as { toJSON: () => unknown }).toJSON());
  }
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    case "object":
      break;
    default:
      // undefined, function, symbol
      return undefined;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const text = serialize(record[key]);
    if (text !== undefined) {
      parts.push(`${JSON.stringify(key)}:${text}`);
    }
  }
  return `{${parts.join(",")}}`;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A revision: the first {@link PROFILE_HASH_LENGTH} hex characters of a
 * sha256. A string or bytes are hashed as they are (a file's text); any other
 * value through {@link stableStringify}, so key order never moves it.
 */
export function contentHash(value: unknown): string {
  const data = typeof value === "string" || value instanceof Uint8Array ? value : stableStringify(value);
  return sha256Hex(data).slice(0, PROFILE_HASH_LENGTH);
}

/** A named item's id: `<kind>:<name>` (`mcp:jira-cloud`, `plugin:superpowers@claude-plugins-official`). */
export function itemId(kind: ProfileItemKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * The fields a hook is identified by: its matcher plus whatever the adapter
 * calls the handler (`command`, `timeoutSec`, a `type`, …). Pass the same
 * normalized shape for a given agent every time — the id is a hash of it.
 */
interface HookIdentity {
  matcher?: string | null;
  [field: string]: unknown;
}

/**
 * A hook's id: `hook:<event>:<16 hex of sha256(stableStringify({matcher, handler}))>`
 * where `handler` is every field but `matcher` (spec §4.3). An absent or empty
 * matcher hashes as `null` — "" and no matcher mean the same to every CLI —
 * and `undefined` handler fields vanish, so optional fields left unset do not
 * move the id.
 */
export function hookItemId(event: string, hook: HookIdentity): string {
  const { matcher, ...handler } = hook;
  const normalized = { matcher: typeof matcher === "string" && matcher.length > 0 ? matcher : null, handler };
  return `hook:${event}:${sha256Hex(stableStringify(normalized)).slice(0, PROFILE_HASH_LENGTH)}`;
}

/**
 * Splits an id at its first `:` into a known kind and a non-empty name; `null`
 * for anything else. A hook's name is `<event>:<hash>`.
 */
export function parseItemId(id: string): { kind: ProfileItemKind; name: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) {
    return null;
  }
  const kind = id.slice(0, colon);
  if (!isProfileItemKind(kind)) {
    return null;
  }
  return { kind, name: id.slice(colon + 1) };
}
