/**
 * Claude's user `settings.json` (`<claudeDir>/settings.json`) — the keys the
 * Claude profile adapter owns a part of, and the hook list inside it.
 *
 * The file is shared by every managed account home through a symlink; infra
 * writes land on the real file. It also carries Orquester's own status hook
 * groups (`agent-hooks.ts` writes them): a group is managed when any of its
 * handlers runs `agent-hook.sh`. Those groups are listed locked and never
 * changed. Every key this module does not touch is written back as parsed,
 * 2-space indented like Claude and `agent-hooks.ts` write it.
 *
 * Keys touched (and only field-wise):
 * - `deniedMcpServers` — `{serverName}` entries (MCP "off");
 * - `skillOverrides.<name>` — `"off"` (skill "off"; "on" deletes the key);
 * - `enabledPlugins.<id>` — `true | false` (plugin toggle);
 * - `hooks.<Event>[group].hooks[handler]` — user hooks.
 */

import { isManagedGroup } from "../../../agent-hooks.ts";
import { hookItemId, type ProfileBackups, readTextIfExists, writeProfileFileVerified } from "../../infra/index.ts";
import { profileErrors } from "../../errors.ts";

export type SettingsDoc = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses settings text; throws an `Error` naming the problem when it is not a JSON object. */
export function parseSettings(text: string): SettingsDoc {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("the top level is not a JSON object");
  }
  return parsed;
}

/**
 * Re-reads `path`, applies `mutate` to the parsed document and writes it back
 * when it changed. A file that does not parse is refused with 409
 * `CONFIG_UNREADABLE` — never overwritten. A missing file starts as `{}` and
 * is created 0600 (settings can hold secrets in `env`).
 */
export async function patchSettings<T>(
  path: string,
  mutate: (doc: SettingsDoc) => T,
  options: { backups: ProfileBackups; agent: string }
): Promise<T> {
  const text = await readTextIfExists(path);
  let doc: SettingsDoc;
  try {
    doc = text === null ? {} : parseSettings(text);
  } catch (error) {
    throw profileErrors.unreadable(path, error instanceof Error ? error.message : String(error));
  }
  const before = JSON.stringify(doc);
  const result = mutate(doc);
  if (JSON.stringify(doc) === before) {
    return result;
  }
  const trailingNewline = text === null || text.endsWith("\n") ? "\n" : "";
  await writeProfileFileVerified(path, `${JSON.stringify(doc, null, 2)}${trailingNewline}`, {
    ...options,
    defaultMode: 0o600,
    verify: parseSettings
  });
  return result;
}

// ---------------------------------------------------------------------------
// deniedMcpServers
// ---------------------------------------------------------------------------

/** Whether a `{serverName: name}` deny entry exists. Other entry shapes (`serverCommand`, `serverUrl`) are not ours. */
export function isMcpDenied(doc: SettingsDoc | null, name: string): boolean {
  const denied = doc?.deniedMcpServers;
  return Array.isArray(denied) && denied.some((entry) => isRecord(entry) && entry.serverName === name);
}

/** Adds `{serverName: name}` unless present; every other entry is kept as it is. */
export function denyMcp(doc: SettingsDoc, name: string): void {
  if (isMcpDenied(doc, name)) return;
  const denied = Array.isArray(doc.deniedMcpServers) ? [...doc.deniedMcpServers] : [];
  denied.push({ serverName: name });
  doc.deniedMcpServers = denied;
}

/** Removes only the `{serverName: name}` entries; an emptied array stays (it may have been there before). */
export function allowMcp(doc: SettingsDoc, name: string): void {
  if (!Array.isArray(doc.deniedMcpServers)) return;
  doc.deniedMcpServers = doc.deniedMcpServers.filter((entry) => !(isRecord(entry) && entry.serverName === name));
}

// ---------------------------------------------------------------------------
// skillOverrides
// ---------------------------------------------------------------------------

/** `on` (default), `name-only`, `user-invocable-only` or `off` — Claude's four values. */
export function skillOverride(doc: SettingsDoc | null, name: string): string | undefined {
  const overrides = doc?.skillOverrides;
  if (!isRecord(overrides)) return undefined;
  const value = overrides[name];
  return typeof value === "string" ? value : undefined;
}

/** Off writes `"off"`; on deletes the key (not `"on"`), and an emptied map. */
export function setSkillOverride(doc: SettingsDoc, name: string, enabled: boolean): void {
  const overrides = isRecord(doc.skillOverrides) ? { ...doc.skillOverrides } : {};
  if (enabled) {
    if (!(name in overrides)) return;
    delete overrides[name];
  } else {
    overrides[name] = "off";
  }
  if (Object.keys(overrides).length === 0) {
    delete doc.skillOverrides;
  } else {
    doc.skillOverrides = overrides;
  }
}

// ---------------------------------------------------------------------------
// enabledPlugins
// ---------------------------------------------------------------------------

/**
 * Claude 2.1.280's own rule (read from the binary): an explicit
 * `enabledPlugins[id]` wins — on when `true` or an array (a version pin list),
 * off otherwise; with no entry the plugin's manifest `defaultEnabled` decides,
 * and it defaults to ON.
 */
export function isPluginEnabled(doc: SettingsDoc | null, id: string, defaultEnabled: unknown): boolean {
  const enabled = doc?.enabledPlugins;
  const value = isRecord(enabled) ? enabled[id] : undefined;
  if (value !== undefined) {
    return value === true || Array.isArray(value);
  }
  return defaultEnabled !== false;
}

export function setPluginEnabled(doc: SettingsDoc, id: string, enabled: boolean): void {
  const map = isRecord(doc.enabledPlugins) ? { ...doc.enabledPlugins } : {};
  map[id] = enabled;
  doc.enabledPlugins = map;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** One handler of `hooks.<event>[i].hooks[j]`, where it sits and whether Orquester owns its group. */
export interface SettingsHook {
  id: string;
  event: string;
  /** `null` for no (or an empty) matcher. */
  matcher: string | null;
  handler: Record<string, unknown>;
  managed: boolean;
}

/** A stashed hook's fragment (spec §4.4): everything needed to put it back. */
export interface HookFragment {
  event: string;
  matcher: string | null;
  handler: Record<string, unknown>;
}

export function normalizeMatcher(matcher: unknown): string | null {
  return typeof matcher === "string" && matcher.length > 0 ? matcher : null;
}

/** The id of a hook: the event plus its matcher and whole handler object. */
export function claudeHookId(event: string, matcher: string | null, handler: Record<string, unknown>): string {
  return hookItemId(event, { ...handler, matcher });
}

/** Every handler in `doc.hooks`, in file order. Malformed groups and handlers are skipped. */
export function listSettingsHooks(doc: SettingsDoc | null): SettingsHook[] {
  const hooks = doc?.hooks;
  if (!isRecord(hooks)) return [];
  const out: SettingsHook[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher = normalizeMatcher(group.matcher);
      const managed = isManagedGroup(group);
      for (const handler of group.hooks) {
        if (!isRecord(handler)) continue;
        out.push({ id: claudeHookId(event, matcher, handler), event, matcher, handler, managed });
      }
    }
  }
  return out;
}

/**
 * Removes the first handler whose id is `id` from a NON-managed group:
 * an emptied group is dropped, then an emptied event array, then an emptied
 * `hooks` object. Answers whether one was removed.
 */
export function removeSettingsHook(doc: SettingsDoc, id: string): boolean {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      if (!isRecord(group) || !Array.isArray(group.hooks) || isManagedGroup(group)) continue;
      const matcher = normalizeMatcher(group.matcher);
      const index = group.hooks.findIndex((handler) => isRecord(handler) && claudeHookId(event, matcher, handler) === id);
      if (index === -1) continue;
      const handlers = group.hooks.filter((_, i) => i !== index);
      const nextGroups = [...groups];
      if (handlers.length === 0) {
        nextGroups.splice(g, 1);
      } else {
        nextGroups[g] = { ...group, hooks: handlers };
      }
      const nextHooks = { ...hooks };
      if (nextGroups.length === 0) {
        delete nextHooks[event];
      } else {
        nextHooks[event] = nextGroups;
      }
      if (Object.keys(nextHooks).length === 0) {
        delete doc.hooks;
      } else {
        doc.hooks = nextHooks;
      }
      return true;
    }
  }
  return false;
}

/**
 * Puts a handler into the first non-managed group of `event` with the same
 * matcher, else into a new group placed before Orquester's managed group (so
 * the managed group stays last, where `agent-hooks.ts` keeps it).
 */
export function insertSettingsHook(doc: SettingsDoc, fragment: HookFragment): void {
  const hooks = isRecord(doc.hooks) ? { ...doc.hooks } : {};
  const groups = Array.isArray(hooks[fragment.event]) ? [...(hooks[fragment.event] as unknown[])] : [];
  const index = groups.findIndex(
    (group) =>
      isRecord(group) &&
      Array.isArray(group.hooks) &&
      !isManagedGroup(group) &&
      normalizeMatcher(group.matcher) === fragment.matcher
  );
  if (index !== -1) {
    const group = groups[index] as Record<string, unknown>;
    groups[index] = { ...group, hooks: [...(group.hooks as unknown[]), fragment.handler] };
  } else {
    const group: Record<string, unknown> = fragment.matcher === null ? {} : { matcher: fragment.matcher };
    group.hooks = [fragment.handler];
    const managedAt = groups.findIndex(isManagedGroup);
    groups.splice(managedAt === -1 ? groups.length : managedAt, 0, group);
  }
  hooks[fragment.event] = groups;
  doc.hooks = hooks;
}

/** Replaces, in place, the first non-managed handler with id `id` whose group keeps the same event and matcher. */
export function replaceSettingsHook(doc: SettingsDoc, id: string, handler: Record<string, unknown>): boolean {
  const hooks = doc.hooks;
  if (!isRecord(hooks)) return false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      if (!isRecord(group) || !Array.isArray(group.hooks) || isManagedGroup(group)) continue;
      const matcher = normalizeMatcher(group.matcher);
      const index = group.hooks.findIndex((h) => isRecord(h) && claudeHookId(event, matcher, h) === id);
      if (index === -1) continue;
      const handlers = [...group.hooks];
      handlers[index] = handler;
      const nextGroups = [...groups];
      nextGroups[g] = { ...group, hooks: handlers };
      doc.hooks = { ...hooks, [event]: nextGroups };
      return true;
    }
  }
  return false;
}
