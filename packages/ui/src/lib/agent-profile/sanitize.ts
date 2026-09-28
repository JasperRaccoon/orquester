/**
 * Agent profile — wire validation. Every snapshot, overview and mutation
 * answer is repaired FIELD BY FIELD before it reaches UI state (AGENTS.md:
 * validate payloads before they reach shared UI state): a daemon of another
 * version may send another shape, and one malformed item costs only itself —
 * it is dropped, never a crash.
 *
 * Permissions fail closed: an item whose `toggleable` / `editable` /
 * `deletable` is not literally `true` offers no such action, and a locked item
 * offers none whatever the rest says.
 */

import {
  isAgentProfileAgentId,
  isProfileItemKind,
  type AgentProfileAgentSummary,
  type AgentProfileSnapshot,
  type ProfileFileError,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemKind,
  type ProfileItemSource,
  type ProfileItemSourceType,
  type ProfileItemWarning,
  type ProfileMutationResponse
} from "@orquester/api";

const SOURCE_TYPES: readonly ProfileItemSourceType[] = ["user", "plugin", "inherited", "bundled", "orquester", "cli"];
const WARNING_ACTIONS = ["trust", "open-file"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const DEFAULT_SOURCE_LABELS: Record<ProfileItemSourceType, string> = {
  user: "User",
  plugin: "Plugin",
  inherited: "Inherited",
  bundled: "Bundled",
  orquester: "Orquester",
  cli: "CLI"
};

function sanitizeSource(value: unknown): ProfileItemSource {
  if (!isRecord(value)) return { type: "user", label: DEFAULT_SOURCE_LABELS.user };
  const type = SOURCE_TYPES.includes(value.type as ProfileItemSourceType)
    ? (value.type as ProfileItemSourceType)
    : "user";
  const source: ProfileItemSource = { type, label: nonEmpty(value.label) ?? DEFAULT_SOURCE_LABELS[type] };
  if (isAgentProfileAgentId(value.ownerAgent)) source.ownerAgent = value.ownerAgent;
  const pluginId = nonEmpty(value.pluginId);
  if (pluginId !== undefined) source.pluginId = pluginId;
  return source;
}

/**
 * The warnings of an item or the instruction file. A bare string (the spec's
 * first draft) is taken as a warning with no code; anything else malformed is
 * dropped.
 */
export function sanitizeWarnings(value: unknown): ProfileItemWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: ProfileItemWarning[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      if (raw.trim().length > 0) warnings.push({ code: "warning", message: raw });
      continue;
    }
    if (!isRecord(raw)) continue;
    const message = nonEmpty(raw.message);
    if (message === undefined) continue;
    const warning: ProfileItemWarning = { code: nonEmpty(raw.code) ?? "warning", message };
    if ((WARNING_ACTIONS as readonly unknown[]).includes(raw.action)) {
      warning.action = raw.action as ProfileItemWarning["action"];
    }
    warnings.push(warning);
  }
  return warnings;
}

function sanitizeMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const meta: Record<string, string> = {};
  let any = false;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.length > 0) {
      meta[key] = entry;
      any = true;
    }
  }
  return any ? meta : undefined;
}

/** One item from the wire, or `null` when it cannot be trusted (no id, an unknown kind). */
export function sanitizeProfileItem(value: unknown): ProfileItem | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  if (id === undefined || !isProfileItemKind(value.kind)) return null;
  const kind: ProfileItemKind = value.kind;
  const locked = value.locked === true;
  const item: ProfileItem = {
    id,
    kind,
    name: nonEmpty(value.name) ?? id,
    enabled: value.enabled !== false,
    toggleable: !locked && value.toggleable === true,
    editable: !locked && value.editable === true,
    deletable: !locked && value.deletable === true,
    locked,
    source: sanitizeSource(value.source),
    revision: str(value.revision) ?? "",
    warnings: sanitizeWarnings(value.warnings)
  };
  const description = nonEmpty(value.description);
  if (description !== undefined) item.description = description;
  const path = nonEmpty(value.path);
  if (path !== undefined) item.path = path;
  if (value.stashed === true) item.stashed = true;
  const meta = sanitizeMeta(value.meta);
  if (meta !== undefined) item.meta = meta;
  return item;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function sanitizeInstructions(value: unknown): ProfileInstructionsInfo {
  const record = isRecord(value) ? value : {};
  const info: ProfileInstructionsInfo = {
    path: str(record.path) ?? "",
    exists: record.exists === true,
    bytes: finiteCount(record.bytes),
    lines: finiteCount(record.lines),
    revision: str(record.revision) ?? "",
    warnings: sanitizeWarnings(record.warnings)
  };
  // The spec's first draft named it `warning` (one string).
  if (info.warnings.length === 0 && nonEmpty(record.warning) !== undefined) {
    info.warnings = [{ code: "warning", message: record.warning as string }];
  }
  const mtime = nonEmpty(record.mtime);
  if (mtime !== undefined && Number.isFinite(Date.parse(mtime))) info.mtime = mtime;
  const legacyPath = nonEmpty(record.legacyPath);
  if (legacyPath !== undefined) info.legacyPath = legacyPath;
  return info;
}

function sanitizeFileErrors(value: unknown): ProfileFileError[] {
  if (!Array.isArray(value)) return [];
  const errors: ProfileFileError[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const path = nonEmpty(raw.path);
    if (path === undefined) continue;
    errors.push({ path, message: nonEmpty(raw.message) ?? "Could not be read." });
  }
  return errors;
}

/**
 * A whole snapshot, or `null` when it names no known agent. Items are
 * sanitized one by one; a duplicate id keeps its first occurrence (ids are
 * the list's keys).
 */
export function sanitizeAgentProfileSnapshot(value: unknown): AgentProfileSnapshot | null {
  if (!isRecord(value) || !isAgentProfileAgentId(value.agent)) return null;
  const items: ProfileItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.items)) {
    for (const raw of value.items) {
      const item = sanitizeProfileItem(raw);
      if (item === null || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  const snapshot: AgentProfileSnapshot = {
    agent: value.agent,
    installed: value.installed !== false,
    revision: str(value.revision) ?? "",
    instructions: sanitizeInstructions(value.instructions),
    items,
    fileErrors: sanitizeFileErrors(value.fileErrors),
    readAt: str(value.readAt) ?? ""
  };
  const version = nonEmpty(value.version);
  if (version !== undefined) snapshot.version = version;
  return snapshot;
}

export function sanitizeAgentSummary(value: unknown): AgentProfileAgentSummary | null {
  if (!isRecord(value) || !isAgentProfileAgentId(value.agent)) return null;
  const counts: AgentProfileAgentSummary["counts"] = {};
  if (isRecord(value.counts)) {
    for (const [kind, count] of Object.entries(value.counts)) {
      if (isProfileItemKind(kind)) counts[kind] = finiteCount(count);
    }
  }
  const summary: AgentProfileAgentSummary = { agent: value.agent, installed: value.installed === true, counts };
  const version = nonEmpty(value.version);
  if (version !== undefined) summary.version = version;
  return summary;
}

/** `GET /api/agent-profile`'s agents, one per known agent (the first wins), or `null` for a wrong shape. */
export function sanitizeOverview(value: unknown): AgentProfileAgentSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.agents)) return null;
  const agents: AgentProfileAgentSummary[] = [];
  for (const raw of value.agents) {
    const summary = sanitizeAgentSummary(raw);
    if (summary !== null && !agents.some((known) => known.agent === summary.agent)) agents.push(summary);
  }
  return agents;
}

/** A mutation's answer: its snapshot (or `null` when that did not parse), ids and notes. */
export function sanitizeMutationResponse(value: unknown): {
  snapshot: AgentProfileSnapshot | null;
  itemIds: string[];
  notes: string[];
} {
  const record: Partial<Record<keyof ProfileMutationResponse, unknown>> = isRecord(value) ? value : {};
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
  return {
    snapshot: sanitizeAgentProfileSnapshot(record.snapshot),
    itemIds: strings(record.itemIds),
    notes: strings(record.notes)
  };
}
