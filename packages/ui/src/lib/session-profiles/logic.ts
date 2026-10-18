/**
 * Agent Profiles — what the library, the editor and the composer chip say,
 * as pure functions of the store's data (agent profiles spec §5.1–§5.3).
 */

import {
  AGENT_PROFILE_AGENT_LABELS,
  SESSION_PROFILE_AGENTS,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileItem,
  type SessionProfileItemKind,
  type SessionProfilePrepareStatus,
  type SessionProfileSummary
} from "@orquester/api";

export const agentLabel = (agent: SessionProfileAgentId): string => AGENT_PROFILE_AGENT_LABELS[agent];

/** The editor's five categories, in the segmented bar's order (spec §5.2). */
export const PROFILE_KIND_ORDER: readonly SessionProfileItemKind[] = ["mcp", "skill", "plugin", "hook", "command"];

export const PROFILE_KIND_LABELS: Record<SessionProfileItemKind, { one: string; many: string; short: string }> = {
  mcp: { one: "MCP server", many: "MCP servers", short: "MCP" },
  skill: { one: "skill", many: "Skills", short: "Skills" },
  plugin: { one: "plugin", many: "Plugins", short: "Plugins" },
  hook: { one: "hook", many: "Hooks", short: "Hooks" },
  command: { one: "command", many: "Commands", short: "Commands" }
};

/** "all agents", "Claude only", "Claude, Codex". */
export function scopeLabel(scope: SessionProfileAgentScope): string {
  if (scope === "all") return "all agents";
  const ordered = SESSION_PROFILE_AGENTS.filter((agent) => scope.includes(agent));
  if (ordered.length === SESSION_PROFILE_AGENTS.length) return "all agents";
  if (ordered.length === 1) return `${agentLabel(ordered[0]!)} only`;
  return ordered.map(agentLabel).join(", ");
}

/** The items of one kind, in the daemon's order. */
export function itemsOfKind(items: readonly SessionProfileItem[], kind: SessionProfileItemKind): SessionProfileItem[] {
  return items.filter((item) => item.kind === kind);
}

/** "2 of 3 on". */
export function enabledLine(items: readonly SessionProfileItem[]): string {
  return `${items.filter((item) => item.enabled).length} of ${items.length} on`;
}

/** The profile's readiness for one agent. */
export function preparationFor(
  profile: Pick<SessionProfileSummary, "preparation">,
  agent: SessionProfileAgentId
): SessionProfilePrepareStatus {
  return profile.preparation.find((status) => status.agent === agent) ?? { agent, state: "not-prepared", updatedAt: "" };
}

/**
 * A library card's status pill (spec §5.1): while any agent is preparing,
 * "Preparing Codex…" (or "Preparing Codex, Grok…"); else when one failed,
 * "Codex failed" with the reasons in the title; else none.
 */
export function profileStatusPill(
  profile: Pick<SessionProfileSummary, "preparation">
): { tone: "busy" | "danger"; text: string; title: string } | null {
  const preparing = profile.preparation.filter((status) => status.state === "preparing");
  if (preparing.length > 0) {
    const names = preparing.map((status) => agentLabel(status.agent)).join(", ");
    return { tone: "busy", text: `Preparing ${names}…`, title: `Preparing this profile for ${names}` };
  }
  const failed = profile.preparation.filter((status) => status.state === "failed");
  if (failed.length > 0) {
    const names = failed.map((status) => agentLabel(status.agent)).join(", ");
    return {
      tone: "danger",
      text: `${names} failed`,
      title: failed.map((status) => `${agentLabel(status.agent)}: ${status.reason ?? "preparation failed"}`).join("\n")
    };
  }
  return null;
}

/** A readiness cell's words: "ready", "preparing", "failed", "not prepared yet". */
export function readinessText(status: SessionProfilePrepareStatus): string {
  switch (status.state) {
    case "ready":
      return "ready";
    case "preparing":
      return "preparing";
    case "failed":
      return "failed";
    default:
      return "not prepared yet";
  }
}

/** A readiness cell's tooltip: the state, and the reason when the daemon gave one. */
export function readinessTitle(status: SessionProfilePrepareStatus): string {
  const head = `${agentLabel(status.agent)}: ${readinessText(status)}`;
  if (status.state === "not-prepared" && status.reason === undefined) {
    return `${head} — it is prepared when a chat first uses it`;
  }
  return status.reason ? `${head} — ${status.reason}` : head;
}

/** "3 skills · 2 MCPs · 1 plugin" — a card's or a menu row's counts; only the kinds it has. */
export function countsLine(profile: Pick<SessionProfileSummary, "counts">): string {
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  add(profile.counts.skill.total, "skill", "skills");
  add(profile.counts.mcp.total, "MCP", "MCPs");
  add(profile.counts.plugin.total, "plugin", "plugins");
  return parts.length > 0 ? parts.join(" · ") : "Empty";
}

/** The library's search: name and description, case-insensitive. */
export function filterProfiles(
  profiles: readonly SessionProfileSummary[],
  query: string
): SessionProfileSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...profiles];
  return profiles.filter(
    (profile) => profile.name.toLowerCase().includes(needle) || profile.description.toLowerCase().includes(needle)
  );
}

/**
 * Why a profile cannot be picked for a chat of `agent`, or `null` when it can
 * (spec §5.3: "a profile not prepared for the chat's agent (preparing/failed)
 * shows disabled with the reason"). A profile not prepared YET is offered: a
 * launch waits for its preparation (§6.5).
 */
export function profileUnavailableReason(
  profile: Pick<SessionProfileSummary, "preparation">,
  agent: SessionProfileAgentId | null
): string | null {
  if (agent === null) return null;
  const status = preparationFor(profile, agent);
  if (status.state === "preparing") return `Preparing for ${agentLabel(agent)}…`;
  if (status.state === "failed") {
    return `Not ready for ${agentLabel(agent)}: ${status.reason ?? "preparation failed"}`;
  }
  return null;
}

export interface ProfileChipEntry {
  id: string;
  name: string;
  icon?: string;
  counts: string;
  /** Why it cannot be picked now, or `null`. */
  disabledReason: string | null;
}

/** The chip menu's profile rows, by name. */
export function profileChipEntries(
  profiles: readonly SessionProfileSummary[],
  agent: SessionProfileAgentId | null
): ProfileChipEntry[] {
  return [...profiles]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      ...(profile.icon !== undefined ? { icon: profile.icon } : {}),
      counts: countsLine(profile),
      disabledReason: profileUnavailableReason(profile, agent)
    }));
}

/**
 * What the chip shows for a thread's `profileId`: Global for none, the
 * profile's name when it is known, "Deleted profile" once the list is
 * loaded and it is not in it, and "Profile" while the list loads.
 */
export function profileChipLabel(
  profileId: string | null | undefined,
  profiles: readonly SessionProfileSummary[] | null
): { label: string; icon?: string; missing: boolean } {
  if (!profileId) return { label: "Global", missing: false };
  const profile = profiles?.find((candidate) => candidate.id === profileId);
  if (profile) return { label: profile.name, ...(profile.icon !== undefined ? { icon: profile.icon } : {}), missing: false };
  return profiles === null ? { label: "Profile", missing: false } : { label: "Deleted profile", missing: true };
}

/** The one line the chip menu says about switching (spec §5.3). */
export const PROFILE_SWITCH_NOTE =
  "Switching restarts the agent and keeps the conversation. Claude and Grok may keep the previous instructions until the conversation is compacted.";

/** One choice of the workflow agent block's Agent Profile picker; `value` "" is Global. */
export interface BlockProfileChoice {
  value: string;
  label: string;
}

/**
 * The agent block's Agent Profile picker (spec 2026-10-18 §5.5): Global first, then every profile
 * by name. A block naming a profile the list does not hold keeps it, marked — never shown as
 * Global (its runs fail until another is picked). While the list is not loaded, the id stands in.
 */
export function blockProfileChoices(
  profiles: readonly Pick<SessionProfileSummary, "id" | "name">[] | null,
  selected: string | undefined
): BlockProfileChoice[] {
  const choices: BlockProfileChoice[] = [{ value: "", label: "Global (the agent's own setup)" }];
  for (const profile of profiles ?? []) choices.push({ value: profile.id, label: profile.name });
  if (selected !== undefined && selected !== "" && !choices.some((choice) => choice.value === selected)) {
    choices.push({ value: selected, label: profiles === null ? selected : "A deleted profile — pick another" });
  }
  return choices;
}

/** The profile a block launches with, for its section summary: "Global", the name, or that it is gone. */
export function blockProfileLabel(profiles: readonly Pick<SessionProfileSummary, "id" | "name">[] | null, selected: string | undefined): string {
  if (selected === undefined || selected === "") return "Global";
  const found = profiles?.find((profile) => profile.id === selected);
  if (found) return found.name;
  return profiles === null ? "an Agent Profile" : "a deleted Agent Profile";
}

/** What an item editor read: the item, and the profile's revision then. */
export interface ItemSaveBase {
  revision: string;
  item: SessionProfileItem;
}

/** A stable rendering of a row: key order does not matter. */
function rowKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(rowKey).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${rowKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Whether the profile held still has the item as the editor read it (its `updatedAt`, else the whole row). */
export function itemUnchanged(
  profile: { readonly items: readonly SessionProfileItem[] } | null,
  base: ItemSaveBase
): boolean {
  const held = profile?.items.find((item) => item.id === base.item.id);
  if (held === undefined) return false;
  if (held.updatedAt !== undefined && base.item.updatedAt !== undefined) return held.updatedAt === base.item.updatedAt;
  return rowKey(held) === rowKey(base.item);
}

/**
 * The revision an item save carries, read when it is sent: the profile's
 * current one — a change to ANOTHER item does not void the draft — unless the
 * item itself changed (or is gone) since the editor read it; then the revision
 * it was read at, so the daemon refuses it (409) rather than overwrite that
 * change. A new item (`base` null) always takes the current one.
 */
export function itemSaveRevision(
  profile: { readonly revision: string; readonly items: readonly SessionProfileItem[] } | null,
  base: ItemSaveBase | null
): string | null {
  if (base === null) return profile?.revision ?? null;
  return profile !== null && itemUnchanged(profile, base) ? profile.revision : base.revision;
}
