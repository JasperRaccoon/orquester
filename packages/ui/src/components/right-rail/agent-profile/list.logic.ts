/**
 * The Agent profile panel's pure rules: the kind tabs and their counts, which
 * tab is shown, the search (across every kind), what "+ Add" lists first, the
 * grouping in `AGENT_PROFILE_KINDS` order, which state the list
 * shows instead of rows, what a row's switch says and why it may be disabled,
 * where an item can be copied to, and the instructions card's line. No React,
 * no store — `list.logic.test.ts` owns them.
 */

import {
  AGENT_PROFILE_AGENT_LABELS,
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_KINDS,
  PROFILE_COPYABLE_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  PROFILE_ITEM_KINDS,
  isProfileItemKind,
  type AgentProfileAgentId,
  type AgentProfileAgentSummary,
  type AgentProfileSnapshot,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemKind
} from "@orquester/api";

import { formatAgo } from "../../../lib/workflows/format";

/** The tabs' short labels ("MCP" rather than "MCP servers"). */
export const PROFILE_KIND_TAB_LABELS: Record<ProfileItemKind, string> = {
  mcp: "MCP",
  skill: "Skills",
  plugin: "Plugins",
  marketplace: "Marketplaces",
  hook: "Hooks",
  command: "Commands"
};

export interface ProfileKindTab {
  id: ProfileItemKind;
  label: string;
  count: number;
}

/** Items per kind. */
export function profileKindCounts(items: readonly ProfileItem[]): Partial<Record<ProfileItemKind, number>> {
  const counts: Partial<Record<ProfileItemKind, number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

/**
 * One tab per kind this agent has, in `AGENT_PROFILE_KINDS` order — each with
 * its count, zero included — then a tab for any other kind that has items (a
 * kind the agent should not have: another daemon version), so every item has
 * a tab to show it under.
 */
export function profileKindTabs(agent: AgentProfileAgentId, items: readonly ProfileItem[]): ProfileKindTab[] {
  const counts = profileKindCounts(items);
  const own = AGENT_PROFILE_KINDS[agent];
  const kinds = [...own, ...PROFILE_ITEM_KINDS.filter((kind) => !own.includes(kind) && (counts[kind] ?? 0) > 0)];
  return kinds.map((kind) => ({ id: kind, label: PROFILE_KIND_TAB_LABELS[kind], count: counts[kind] ?? 0 }));
}

/**
 * The tab shown: the remembered one when it is among `tabs` (a stored value
 * may come from another app version, or be junk), else the first tab — the
 * agent's first kind.
 */
export function effectiveKindTab(tabs: readonly ProfileKindTab[], remembered: unknown): ProfileItemKind {
  const found = isProfileItemKind(remembered) ? tabs.find((tab) => tab.id === remembered) : undefined;
  return found?.id ?? tabs[0]?.id ?? PROFILE_ITEM_KINDS[0];
}

/** The search is on: it looks across every kind, whatever the tab. */
export function isProfileSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

/** The kind an item id names (`<kind>:<name>`, hooks `hook:<event>:<hash>`), or `null`. */
export function profileItemKindOfId(id: string): ProfileItemKind | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const prefix = id.slice(0, colon);
  return isProfileItemKind(prefix) ? prefix : null;
}

/** "+ Add"'s kinds: the shown tab's kind first when it can be created, then the rest in their order. */
export function addMenuKinds(creatable: readonly ProfileItemKind[], active: ProfileItemKind): ProfileItemKind[] {
  return creatable.includes(active) ? [active, ...creatable.filter((kind) => kind !== active)] : [...creatable];
}

/** Every whitespace-separated word of `query` appears in the item's name, description, source or meta line. */
export function matchesProfileQuery(item: ProfileItem, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const haystack = [item.name, item.description ?? "", item.source.label, ...profileItemMetaParts(item)]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------------------
// A row's meta line
// ---------------------------------------------------------------------------

/**
 * `meta` keys that are not one-liners for the row: `offNote` is the Claude
 * MCP off switch's caveat (it goes in the switch's tooltip, {@link switchTitle}).
 */
const META_NOT_SHOWN: ReadonlySet<string> = new Set(["offNote"]);

/** The order the known keys read in; any other key follows, as sent. */
const META_ORDER = [
  "transport",
  "target",
  "command",
  "url",
  "event",
  "matcher",
  "type",
  "timeout",
  "file",
  "in",
  "version",
  "marketplace",
  "source",
  "branch",
  "installedPlugins",
  "options",
  "override",
  "symlink"
] as const;

/**
 * The kind-specific facts an adapter puts in `item.meta`, as the words the
 * row's second line shows ("stdio · npx -y jira-mcp", "v5.0.7", "3 installed").
 * Nothing the row already says twice (a hook's event and matcher are its
 * description on some agents; a plugin id already names its marketplace), no
 * bare flags ("true", "yes"), and never a key that is not a one-liner.
 */
export function profileItemMetaParts(item: Pick<ProfileItem, "kind" | "name" | "description" | "meta">): string[] {
  const meta = item.meta ?? {};
  const description = item.description ?? "";
  const keys = [
    ...META_ORDER.filter((key) => key in meta),
    ...Object.keys(meta).filter((key) => !(META_ORDER as readonly string[]).includes(key))
  ];
  const parts: string[] = [];
  for (const key of keys) {
    if (META_NOT_SHOWN.has(key)) continue;
    const value = meta[key]?.trim() ?? "";
    if (value === "") continue;
    const shown = metaPart(key, value, item.kind, item.name, description);
    if (shown !== null && !parts.includes(shown)) parts.push(shown);
  }
  return parts;
}

/**
 * A row's second line: the meta as words, then the description. A hook with
 * an event reads from its meta alone — event first, then the matcher — as
 * the adapters each describe one differently ("PreToolUse · Bash",
 * "Matcher: Bash", "Stop"), and the rows of one list should read alike.
 */
export function profileItemSecondLine(item: Pick<ProfileItem, "kind" | "name" | "description" | "meta">): string {
  if (item.kind === "hook" && (item.meta?.event ?? "").trim() !== "") {
    return profileItemMetaParts({ ...item, description: undefined }).join(" · ");
  }
  return [...profileItemMetaParts(item), ...(item.description ? [item.description] : [])].join(" · ");
}

/**
 * The name as a row shows it. A hook is named by its command, whose absolute
 * paths would fill the row before the part that tells hooks apart:
 * `'/var/lib/orquester/daemon/hooks/agent-hook.sh' claude Stop` reads
 * `'…/agent-hook.sh' claude Stop` (the tooltip keeps it whole).
 */
export function profileItemDisplayName(item: Pick<ProfileItem, "kind" | "name">): string {
  if (item.kind !== "hook") return item.name;
  return item.name.replace(/(^|[\s'"=])\/(?:[^\s'"/]+\/)+([^\s'"/]+)/g, "$1…/$2");
}

function metaPart(key: string, value: string, kind: ProfileItemKind, name: string, description: string): string | null {
  switch (key) {
    case "event":
    case "matcher":
      // Claude and Grok already describe a hook as "Event · matcher".
      return description.includes(value) ? null : value;
    case "type":
      // A hook's handler type: only an unusual one is worth a word.
      return value === "command" ? null : `${value} hook`;
    case "timeout":
      return `timeout ${value}`;
    case "version":
      return /^\d/.test(value) ? `v${value}` : value;
    case "marketplace":
      // `superpowers@claude-plugins-official` names it already.
      return name.includes(value) ? null : value;
    case "installedPlugins":
      return value === "0" ? null : `${value} installed`;
    case "branch":
      return `branch ${value}`;
    case "in":
      return value === "config" ? "in the config file" : `in ${value}`;
    case "options":
      return value === "yes" || value === "true" ? "with options" : null;
    case "symlink":
      return value === "true" ? "symlink" : null;
    case "override":
      return `skillOverrides: ${value}`;
    case "source":
      if (kind === "plugin") return value === "file" ? "local file" : value === "npm" ? "npm package" : null;
      return value;
    default:
      return value;
  }
}

/** The tab's items; while searching, the matches of every kind instead. */
export function filterProfileItems(
  items: readonly ProfileItem[],
  filter: { kind: ProfileItemKind; query: string }
): ProfileItem[] {
  if (isProfileSearchActive(filter.query)) return items.filter((item) => matchesProfileQuery(item, filter.query));
  return items.filter((item) => item.kind === filter.kind);
}

export interface ProfileItemGroup {
  kind: ProfileItemKind;
  /** The section label: "MCP servers", "Skills", … */
  label: string;
  items: ProfileItem[];
}

const byName = (a: ProfileItem, b: ProfileItem): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);

/**
 * One group per kind that has items, in `AGENT_PROFILE_KINDS[agent]` order
 * (a kind the agent should not have — another daemon version — after them),
 * each sorted by name.
 */
export function groupProfileItems(agent: AgentProfileAgentId, items: readonly ProfileItem[]): ProfileItemGroup[] {
  const order: ProfileItemKind[] = [
    ...AGENT_PROFILE_KINDS[agent],
    ...PROFILE_ITEM_KINDS.filter((kind) => !AGENT_PROFILE_KINDS[agent].includes(kind))
  ];
  const groups: ProfileItemGroup[] = [];
  for (const kind of order) {
    const ofKind = items.filter((item) => item.kind === kind);
    if (ofKind.length > 0) {
      groups.push({ kind, label: PROFILE_ITEM_KIND_LABELS[kind].many, items: [...ofKind].sort(byName) });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentProfileAgentOption {
  id: AgentProfileAgentId;
  label: string;
  /** `null` until the overview (or the agent's own snapshot) says. */
  installed: boolean | null;
  version?: string;
}

/** The picker's four agents, installed or not, as far as the overview and the loaded snapshots know. */
export function agentProfileAgentOptions(
  overview: readonly AgentProfileAgentSummary[] | null,
  snapshots: Partial<Record<AgentProfileAgentId, AgentProfileSnapshot | null>> = {}
): AgentProfileAgentOption[] {
  return AGENT_PROFILE_AGENTS.map((id) => {
    const snapshot = snapshots[id] ?? null;
    const summary = overview?.find((entry) => entry.agent === id);
    const installed = snapshot !== null ? snapshot.installed : (summary?.installed ?? null);
    const version = snapshot?.version ?? summary?.version;
    return { id, label: AGENT_PROFILE_AGENT_LABELS[id], installed, ...(version ? { version } : {}) };
  });
}

/** The agent is known not to be installed: its snapshot says so, the load was refused so, or the overview says so. */
export function isAgentNotInstalled(input: {
  snapshot: AgentProfileSnapshot | null;
  errorCode: string | null;
  overviewInstalled: boolean | null;
}): boolean {
  if (input.snapshot !== null) return !input.snapshot.installed;
  if (input.errorCode === "AGENT_NOT_INSTALLED") return true;
  return input.overviewInstalled === false;
}

// ---------------------------------------------------------------------------
// What the list shows
// ---------------------------------------------------------------------------

export type AgentProfileEmptyState =
  | { kind: "loading" }
  | { kind: "not-installed"; agent: AgentProfileAgentId }
  | { kind: "error"; message: string }
  /** A tab with nothing under it: "No MCP servers yet." */
  | { kind: "empty-kind"; itemKind: ProfileItemKind }
  | { kind: "no-matches"; query: string };

/** What the list shows instead of rows, or `null` for rows. */
export function agentProfileEmptyState(input: {
  agent: AgentProfileAgentId;
  status: "idle" | "loading" | "ready" | "error";
  snapshot: AgentProfileSnapshot | null;
  error: string | null;
  notInstalled: boolean;
  /** The tab shown. */
  kind: ProfileItemKind;
  query: string;
  /** How many rows the tab or the search leaves. */
  shown: number;
}): AgentProfileEmptyState | null {
  if (input.notInstalled) return { kind: "not-installed", agent: input.agent };
  if (input.snapshot === null) {
    if (input.status === "error") return { kind: "error", message: input.error ?? "The daemon did not answer." };
    return { kind: "loading" };
  }
  if (input.shown > 0) return null;
  const query = input.query.trim();
  if (query.length > 0) return { kind: "no-matches", query };
  return { kind: "empty-kind", itemKind: input.kind };
}

/** "No MCP servers yet." */
export function emptyKindTitle(kind: ProfileItemKind): string {
  const many = PROFILE_ITEM_KIND_LABELS[kind].many;
  // "MCP" stays upper case; the rest read as words ("No skills yet.").
  return `No ${kind === "mcp" ? many : many.toLowerCase()} yet.`;
}

export function notInstalledTitle(agent: AgentProfileAgentId): string {
  return `${AGENT_PROFILE_AGENT_LABELS[agent]} is not installed.`;
}

export const NOT_INSTALLED_HINT = "Install it from Settings → Agents.";

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

/** The switch's accessible name: what pressing it does. */
export function switchLabel(item: Pick<ProfileItem, "name" | "enabled">): string {
  return `${item.enabled ? "Turn off" : "Turn on"} ${item.name}`;
}

/** Why the switch is disabled, or `null` when it is not. */
export function switchDisabledReason(item: ProfileItem): string | null {
  if (item.toggleable) return null;
  if (item.locked) {
    return item.source.type === "cli"
      ? "Locked — the agent's CLI manages this"
      : "Locked — Orquester manages this";
  }
  const { source } = item;
  if (source.type === "inherited") {
    return source.ownerAgent !== undefined
      ? `Manage in ${AGENT_PROFILE_AGENT_LABELS[source.ownerAgent]}`
      : `Shared — manage it where it lives${item.path ? ` (${item.path})` : ""}`;
  }
  if (source.type === "plugin") return `Managed by plugin ${source.pluginId ?? source.label.replace(/^Plugin · /, "")}`;
  if (source.type === "bundled") return "Bundled with the agent — can't be turned off here";
  return "Can't be turned off here";
}

/**
 * What the switch's tooltip says when it works — with what turning it off
 * does beyond this item when the adapter says (`meta.offNote`: Claude's
 * `deniedMcpServers` also blocks a project server of that name).
 */
export function switchTitle(item: ProfileItem): string {
  const offNote = item.meta?.offNote?.trim();
  if (item.enabled) return offNote ? `On — loaded by new sessions. ${offNote}` : "On — loaded by new sessions";
  return item.stashed ? "Off — set aside by Orquester until turned back on" : "Off — not loaded";
}

/** The other installed agents that have this item's kind, for "Copy to…" — none for a kind that does not copy. */
export function copyTargets(
  item: Pick<ProfileItem, "kind">,
  agent: AgentProfileAgentId,
  installed: (agent: AgentProfileAgentId) => boolean | null
): AgentProfileAgentId[] {
  if (!PROFILE_COPYABLE_KINDS.includes(item.kind)) return [];
  return AGENT_PROFILE_AGENTS.filter(
    (target) => target !== agent && AGENT_PROFILE_KINDS[target].includes(item.kind) && installed(target) === true
  );
}

/** The agent an inherited item is managed in, when it names one. */
export function manageInAgent(item: ProfileItem): AgentProfileAgentId | null {
  return item.source.type === "inherited" ? (item.source.ownerAgent ?? null) : null;
}

// ---------------------------------------------------------------------------
// The instructions card
// ---------------------------------------------------------------------------

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
}

/** "CLAUDE.md" and "42 lines · edited 2h ago" (or "Not created yet"). */
export function instructionsLine(
  info: ProfileInstructionsInfo,
  now: number
): { fileName: string; detail: string } {
  const fileName = fileNameOf(info.path) || "Instructions";
  if (!info.exists) return { fileName, detail: "Not created yet — click to write it" };
  const parts = [`${info.lines} ${info.lines === 1 ? "line" : "lines"}`];
  const ago = formatAgo(info.mtime ?? null, now);
  if (ago.length > 0) parts.push(`edited ${ago}`);
  return { fileName, detail: parts.join(" · ") };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Below this PANEL width (px) the agent picker is one dropdown rather than a
 * segmented control of four icon + name buttons: those measure about 308 px
 * with a wide system font (DejaVu Sans at 12 px) — the buttons, their gaps
 * and the group's padding — and the panel keeps 24 px of padding, so a panel
 * any narrower would clip "OpenCode". The dock's default 320 px (319 inside
 * its border) shows the dropdown; a 360 px phone's section (352) the segments.
 */
export const AGENT_PICKER_SEGMENTED_MIN_WIDTH = 336;

export function agentPickerLayout(panelWidth: number | null): "segmented" | "dropdown" {
  // Not measured yet (the first paint, a static render): a phone's full
  // screen fits the segments.
  if (panelWidth === null) return "segmented";
  return panelWidth < AGENT_PICKER_SEGMENTED_MIN_WIDTH ? "dropdown" : "segmented";
}
