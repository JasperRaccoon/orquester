/**
 * Grok's hook files: `~/.grok/hooks/*.json`, each
 * `{"hooks": {<Event>: [{matcher?, hooks: [{type: "command", command, timeout?}]}]}}`
 * (the user guide's chapter 10). One profile item per handler; a handler's
 * identity is its file, event, matcher and the whole handler object.
 *
 * These are pure functions over the parsed JSON: the adapter reads and writes
 * the files. Every edit answers a fresh object and keeps keys it does not know
 * (other top-level keys, other group and handler fields).
 */

import { hookItemId, stableStringify } from "../../infra/index.ts";

export type JsonObject = Record<string, unknown>;

/** One handler where it lives. */
export interface HookLocation {
  /** The file's base name (`profile.json`); `config.toml` for a `[[hooks.<Event>]]` handler. */
  file: string;
  event: string;
  /** Absent or empty = matches everything. */
  matcher?: string;
  handler: JsonObject;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `""` and absent are the same matcher to Grok. */
export function normalizeMatcher(matcher: unknown): string | undefined {
  return typeof matcher === "string" && matcher.length > 0 ? matcher : undefined;
}

export function hookId(location: HookLocation): string {
  return hookItemId(location.event, {
    matcher: location.matcher ?? null,
    file: location.file,
    handler: location.handler
  });
}

/** Parses a hook file; throws an `Error` when it is not JSON or not an object with an object `hooks`. */
export function parseHookFile(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error("A hook file must hold a JSON object.");
  }
  if (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) {
    throw new Error('"hooks" must be an object of events.');
  }
  return parsed;
}

/**
 * Every handler of a parsed hook file (or a config.toml `hooks` table), in
 * file order. Groups and handlers that are not objects are skipped.
 */
export function listHandlers(file: string, hooks: unknown): HookLocation[] {
  const out: HookLocation[] = [];
  if (!isJsonObject(hooks)) {
    return out;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) continue;
      const matcher = normalizeMatcher(group.matcher);
      for (const handler of group.hooks) {
        if (!isJsonObject(handler)) continue;
        out.push({ file, event, ...(matcher !== undefined ? { matcher } : {}), handler });
      }
    }
  }
  return out;
}

function sameHandler(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * The file without the handler at `location` (its first match). A group left
 * with no handlers is dropped, and so is an event left with no groups; the
 * `hooks` object itself stays (`{"hooks": {}}`). Answers `null` when the
 * handler is not in the file.
 */
export function removeHandler(data: JsonObject, location: HookLocation): JsonObject | null {
  const next = structuredClone(data);
  const hooks = isJsonObject(next.hooks) ? next.hooks : null;
  const groups = hooks?.[location.event];
  if (hooks === null || !Array.isArray(groups)) {
    return null;
  }
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    if (!isJsonObject(group) || !Array.isArray(group.hooks) || normalizeMatcher(group.matcher) !== location.matcher) {
      continue;
    }
    const index = group.hooks.findIndex((handler) => sameHandler(handler, location.handler));
    if (index === -1) continue;
    group.hooks.splice(index, 1);
    if (group.hooks.length === 0) {
      groups.splice(g, 1);
    }
    if (groups.length === 0) {
      delete hooks[location.event];
    }
    return next;
  }
  return null;
}

/**
 * The file with the handler added: into the first group of that event with
 * the same matcher, else a new group at the end. `data` may be `{}` (a new
 * file). An identical handler already in that group is not added twice.
 */
export function insertHandler(data: JsonObject, location: HookLocation): JsonObject {
  const next = structuredClone(data);
  if (!isJsonObject(next.hooks)) {
    next.hooks = {};
  }
  const hooks = next.hooks as JsonObject;
  if (!Array.isArray(hooks[location.event])) {
    hooks[location.event] = [];
  }
  const groups = hooks[location.event] as unknown[];
  const group = groups.find(
    (candidate): candidate is JsonObject & { hooks: unknown[] } =>
      isJsonObject(candidate) && Array.isArray(candidate.hooks) && normalizeMatcher(candidate.matcher) === location.matcher
  );
  if (group !== undefined) {
    if (!group.hooks.some((handler) => sameHandler(handler, location.handler))) {
      group.hooks.push(location.handler);
    }
    return next;
  }
  groups.push({ ...(location.matcher !== undefined ? { matcher: location.matcher } : {}), hooks: [location.handler] });
  return next;
}

/**
 * The file with the handler at `from` replaced by `to`: in place when the
 * event and matcher stay, else removed and inserted. `null` when `from` is
 * not in the file.
 */
export function replaceHandler(data: JsonObject, from: HookLocation, to: HookLocation): JsonObject | null {
  if (from.event === to.event && from.matcher === to.matcher) {
    const next = structuredClone(data);
    const groups = isJsonObject(next.hooks) ? next.hooks[from.event] : undefined;
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      if (!isJsonObject(group) || !Array.isArray(group.hooks) || normalizeMatcher(group.matcher) !== from.matcher) continue;
      const index = group.hooks.findIndex((handler) => sameHandler(handler, from.handler));
      if (index === -1) continue;
      group.hooks[index] = to.handler;
      return next;
    }
    return null;
  }
  const removed = removeHandler(data, from);
  return removed === null ? null : insertHandler(removed, to);
}

export function serializeHookFile(data: JsonObject): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
