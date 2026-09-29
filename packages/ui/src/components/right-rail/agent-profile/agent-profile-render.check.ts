/**
 * Render smoke checks for the Agent profile panel (spec §7.3, §7.5).
 *
 * `list.logic.test.ts`, `default-agent.test.ts` and `lib/agent-profile/*.test.ts`
 * own the rules; this exists because "a locked row's switch is disabled and
 * says why", "a warning with a trust action has a Trust button", "every
 * phone target is 40 px", "the picker collapses on a narrow panel" and "the
 * not-installed agent says where to install it" are claims about MARKUP — a
 * prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The menus' panels, the dialogs and the bottom sheets are portals that mount
 * only when open; a static render has no viewport, so an `AdaptiveMenu`
 * renders its phone trigger.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AGENT_PROFILE_CREATABLE_KINDS,
  type AgentProfileAgentId,
  type AgentProfileSnapshot,
  type ProfileItem,
  type ProfileItemKind
} from "@orquester/api";

import { AgentProfilePanelView, type AgentProfilePanelViewProps, type ProfileItemActions } from "./AgentProfilePanelView";
import { kindTabKeyTarget } from "./KindTabs";
import {
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  effectiveKindTab,
  filterProfileItems,
  groupProfileItems,
  profileKindTabs
} from "./list.logic";
import { ProfileItemRow, type ProfileItemRowProps } from "./ProfileItemRow";

const render = (element: ReactElement): string => renderToStaticMarkup(element);
const NOOP = (): void => {};
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function item(overrides: Partial<ProfileItem> & { id: string }): ProfileItem {
  return {
    kind: "mcp",
    name: overrides.id.replace(/^\w+:/, ""),
    enabled: true,
    toggleable: true,
    editable: true,
    deletable: true,
    locked: false,
    source: { type: "user", label: "User" },
    path: `/var/lib/orquester/.claude/${overrides.id}`,
    revision: "r",
    warnings: [],
    ...overrides
  };
}

const USER = item({ id: "mcp:jira-cloud", description: "Jira issues, sprints and boards", meta: { transport: "stdio" } });
const OFF = item({ id: "mcp:serena", enabled: false, description: "Semantic code tools" });
const STASHED = item({ id: "command:deploy", kind: "command", enabled: false, stashed: true });
const LOCKED = item({
  id: "hook:Stop:0123456789abcdef",
  kind: "hook",
  name: "agent-hook.sh",
  toggleable: false,
  editable: false,
  deletable: false,
  locked: true,
  source: { type: "orquester", label: "Orquester" },
  meta: { event: "Stop" }
});
const INHERITED = item({
  id: "skill:review",
  kind: "skill",
  toggleable: false,
  editable: false,
  deletable: false,
  description: "Review the current diff",
  source: { type: "inherited", label: "From Claude", ownerAgent: "claude" }
});
const PLUGIN_HOOK = item({
  id: "hook:SessionStart:aaaaaaaaaaaaaaaa",
  kind: "hook",
  name: "session-start",
  toggleable: false,
  editable: false,
  deletable: false,
  path: undefined,
  source: { type: "plugin", label: "Plugin · superpowers", pluginId: "superpowers" }
});
const BUNDLED = item({
  id: "skill:.system-imagegen",
  kind: "skill",
  name: "imagegen",
  editable: false,
  deletable: false,
  source: { type: "bundled", label: "Bundled" }
});
const UNTRUSTED = item({
  id: "hook:PreToolUse:fedcba9876543210",
  kind: "hook",
  name: "lint-on-edit",
  meta: { event: "PreToolUse", matcher: "Edit" },
  warnings: [{ code: "untrusted", message: "Not trusted by Codex", action: "trust" }]
});
const CACHE = item({
  id: "plugin:superpowers@claude-plugins-official",
  kind: "plugin",
  name: "superpowers@claude-plugins-official-with-a-very-long-marketplace-name",
  editable: false,
  source: { type: "plugin", label: "Plugin · claude-plugins-official" },
  warnings: [{ code: "cache-missing", message: "Plugin cache missing" }]
});

const ITEMS = [USER, OFF, STASHED, LOCKED, INHERITED, PLUGIN_HOOK, BUNDLED, UNTRUSTED, CACHE];

function snapshot(agent: AgentProfileAgentId, overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    agent,
    installed: true,
    version: "1.0.0",
    revision: "r1",
    instructions: {
      path: agent === "claude" ? "/var/lib/orquester/.claude/CLAUDE.md" : `/var/lib/orquester/.${agent}/AGENTS.md`,
      exists: true,
      bytes: 2048,
      lines: 42,
      mtime: "2026-09-28T10:00:00.000Z",
      revision: "i1",
      warnings: []
    },
    items: ITEMS,
    fileErrors: [],
    readAt: "2026-09-28T12:00:00.000Z",
    ...overrides
  };
}

const ACTIONS: ProfileItemActions = {
  toggle: NOOP,
  edit: NOOP,
  copyTo: NOOP,
  copyPath: NOOP,
  remove: NOOP,
  trust: NOOP,
  manageIn: NOOP,
  confirmRemove: NOOP,
  resolveConflict: NOOP,
  cancelConfirm: NOOP
};

const OVERVIEW = [
  { agent: "claude" as const, installed: true, counts: {} },
  { agent: "codex" as const, installed: true, counts: {} },
  { agent: "grok" as const, installed: false, counts: {} },
  { agent: "opencode" as const, installed: true, counts: {} }
];

/** The view as the container would draw it for `snap`, with the state the logic derives. */
function viewProps(
  options: {
    agent?: AgentProfileAgentId;
    snap?: AgentProfileSnapshot | null;
    status?: "idle" | "loading" | "ready" | "error";
    error?: string | null;
    notInstalled?: boolean;
    /** The tab as the container picks it from this remembered value: the agent's first by default. */
    remembered?: unknown;
    query?: string;
  } & Partial<AgentProfilePanelViewProps> = {}
): AgentProfilePanelViewProps {
  const agent = options.agent ?? "claude";
  const snap = options.snap === undefined ? snapshot(agent) : options.snap;
  const query = options.query ?? "";
  const items = snap?.items ?? [];
  const tabs = profileKindTabs(agent, items);
  const kind: ProfileItemKind = options.kind ?? effectiveKindTab(tabs, options.remembered);
  const filtered = filterProfileItems(items, { kind, query });
  const installed = (target: AgentProfileAgentId) => OVERVIEW.find((entry) => entry.agent === target)?.installed ?? null;
  return {
    variant: "docked",
    width: 400,
    agent,
    agents: agentProfileAgentOptions(OVERVIEW),
    onAgentChange: NOOP,
    query,
    onQueryChange: NOOP,
    kind,
    onKindChange: NOOP,
    tabs,
    snapshot: snap,
    groups: groupProfileItems(agent, filtered),
    empty: agentProfileEmptyState({
      agent,
      status: options.status ?? (snap ? "ready" : "loading"),
      snapshot: snap,
      error: options.error ?? null,
      notInstalled: options.notInstalled ?? false,
      kind,
      query,
      shown: filtered.length
    }),
    loadError: null,
    onRetry: NOOP,
    notice: null,
    onDismissNotice: NOOP,
    now: NOW,
    pendingIds: new Set(),
    highlightId: null,
    confirming: null,
    copyTargetsFor: (entry) => copyTargets(entry, agent, installed),
    actions: ACTIONS,
    onOpenInstructions: NOOP,
    creatableKinds: AGENT_PROFILE_CREATABLE_KINDS[agent],
    onAdd: NOOP,
    ...options
  };
}

const view = (props: AgentProfilePanelViewProps): string => render(createElement(AgentProfilePanelView, props));

/** The panel drawn on each of the agent's tabs in turn — every row, each under its own tab. */
function everyTab(options: Parameters<typeof viewProps>[0] = {}): string {
  return viewProps(options)
    .tabs.map((tab) => view(viewProps({ ...options, kind: tab.id })))
    .join("\n");
}

/** The tablist, from its opening tag to its closing one. */
const tablistOf = (html: string): string => html.match(/<div role="tablist"[\s\S]*?<\/button><\/div>/)?.[0] ?? "";

/** Each tab's opening tag and content, keyed by kind. */
function tabsOf(html: string): Map<string, string> {
  const tabs = new Map<string, string>();
  for (const match of tablistOf(html).matchAll(/<button[^>]*data-kind-tab="(\w+)"[\s\S]*?<\/button>/g)) {
    tabs.set(match[1]!, match[0]);
  }
  return tabs;
}

/** The row element listing `id`, up to the next row (or the end). */
function rowOf(html: string, id: string): string {
  const start = html.indexOf(`data-profile-item="${id}"`);
  assert.ok(start >= 0, `row ${id} is listed`);
  const next = html.indexOf("data-profile-item=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

const switchOf = (row: string): string => row.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";

// ---------------------------------------------------------------------------
// Ready: the panel's parts and every row state
// ---------------------------------------------------------------------------

{
  const html = view(viewProps());
  assert.ok(html.startsWith('<div data-agent-profile-panel="" class="flex min-h-0 flex-1 flex-col">'), "the dock's panel contract");
  assert.ok(/class="min-h-0 flex-1 space-y-1\.5 overflow-y-auto px-3 pb-3/.test(html), "the list scrolls itself, px-3");

  // The picker, wide: four segments, the not-installed one disabled with a reason.
  assert.ok(html.includes('data-agent-picker="segmented"'), "a 400 px panel shows the segmented picker");
  const segments = html.match(/<div role="group" aria-label="Agent"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.equal((segments.match(/<button/g) ?? []).length, 4, "four agents");
  assert.ok(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Claude<\/button>/.test(segments), "Claude is the pressed one");
  assert.ok(/<button[^>]*disabled=""[^>]*title="Grok is not installed"/.test(segments), "Grok, not installed, is disabled and says so");
  assert.ok(segments.includes(">OpenCode</button>"), "OpenCode by its whole name");
  // The SVG artwork is stubbed under node; its slot is not.
  assert.equal((segments.match(/<span aria-hidden="true" class="flex h-3\.5 w-3\.5/g) ?? []).length, 4, "an icon per agent");

  // The instructions card, pinned above the search and the tabs (outside the scrolling list).
  assert.ok(html.includes('data-profile-instructions=""'), "the instructions card");
  assert.ok(html.includes("CLAUDE.md") && html.includes("42 lines · edited 2h ago"), "file, lines, edited ago");
  const cardAt = html.indexOf("data-profile-instructions");
  const searchAt = html.indexOf('aria-label="Search Claude&#x27;s profile"');
  const tablistAt = html.indexOf('role="tablist"');
  const listAt = html.indexOf('role="tabpanel"');
  assert.ok(cardAt > 0 && cardAt < searchAt && searchAt < tablistAt && tablistAt < listAt, "card, search, tabs, then the list");

  // The tabs: one per kind, no All, wrapping — never a scroll row, never a fade.
  const tablist = tablistOf(html);
  assert.ok(/<div role="tablist" aria-label="Kinds" aria-orientation="horizontal"/.test(tablist), "a named tablist");
  assert.ok(/class="flex flex-wrap transition-opacity gap-1(\.5)?[ "]/.test(tablist), "it wraps onto more lines");
  assert.ok(!/overflow-x-auto|flex-nowrap|mask-image/.test(html), "no scroll row, no edge fades");
  const tabs = tabsOf(html);
  assert.deepEqual([...tabs.keys()], ["mcp", "skill", "plugin", "marketplace", "hook", "command"], "the agent's kinds, in order");
  assert.ok(!/>All</.test(tablist), "no All tab");
  for (const [kind, tab] of tabs) {
    assert.ok(/role="tab"/.test(tab) && /\bwhitespace-nowrap\b/.test(tab) && !/\btruncate\b/.test(tab), `${kind}: a whole tab`);
    assert.ok(/<svg[^>]*class="lucide lucide-[\w-]+ shrink-0/.test(tab), `${kind}: its icon`);
    assert.ok(/data-kind-count=""[^>]*class="[^"]*rounded-full/.test(tab), `${kind}: its count as a badge`);
  }
  for (const [kind, icon] of [["mcp", "server"], ["skill", "sparkles"], ["plugin", "puzzle"], ["marketplace", "store"], ["hook", "webhook"], ["command", "square-slash"]]) {
    assert.ok(tabs.get(kind)!.includes(`lucide-${icon} `), `${kind}: the ${icon} icon`);
  }
  // The shown tab: selected, the one tab stop, filled.
  const mcp = tabs.get("mcp")!;
  const labelledBy = html.match(/role="tabpanel" aria-labelledby="([^"]+)"/)?.[1] ?? "";
  assert.ok(/aria-selected="true"/.test(mcp) && /tabindex="0"/.test(mcp), "MCP, the agent's first kind, is the tab shown");
  assert.ok(/\bbg-neutral-100 text-neutral-900\b/.test(mcp), "filled");
  assert.ok(mcp.includes(`id="${labelledBy}"`), "and it labels the list");
  const panelId = html.match(/<div id="([^"]+)" tabindex="-1" role="tabpanel"/)?.[1] ?? "";
  assert.ok(panelId.length > 0 && mcp.includes(`aria-controls="${panelId}"`), "which it controls");
  for (const kind of ["skill", "plugin", "marketplace", "hook", "command"]) {
    const tab = tabs.get(kind)!;
    assert.ok(/aria-selected="false"/.test(tab) && /tabindex="-1"/.test(tab), `${kind}: not selected, no tab stop`);
    assert.ok(!/bg-neutral-100 text-neutral-900/.test(tab) && /\bborder\b/.test(tab), `${kind}: an outlined pill`);
    assert.ok(/hover:border-neutral-700/.test(tab), `${kind}: with a hover`);
    assert.ok(/focus-visible:ring-2/.test(tab), `${kind}: and a focus ring`);
  }
  assert.ok(/MCP<span data-kind-count=""[^>]*bg-neutral-900 text-neutral-100[^>]*><span class="sr-only">, <\/span>2</.test(mcp), "MCP 2, the badge contrasting");
  assert.ok(/Hooks<span data-kind-count=""[^>]*bg-neutral-800 text-neutral-400[^>]*><span class="sr-only">, <\/span>3</.test(tabs.get("hook")!), "Hooks 3, muted");
  // A 0-count kind keeps its tab, muted.
  const marketplace = tabs.get("marketplace")!;
  assert.ok(/Marketplaces<span[^>]*text-neutral-600[^>]*><span class="sr-only">, <\/span>0</.test(marketplace), "Marketplaces 0");
  assert.ok(/text-neutral-500 hover:/.test(marketplace) && /lucide-store shrink-0 text-neutral-600/.test(marketplace), "reads muted");
  assert.ok(/\bh-8\b/.test(mcp), "a comfortable 32 px in the dock");

  // The list: only the shown tab's rows, no section label over them.
  assert.ok(html.includes(`data-profile-item="${USER.id}"`) && html.includes(`data-profile-item="${OFF.id}"`), "MCP's rows");
  for (const other of [STASHED, LOCKED, INHERITED, CACHE]) assert.ok(!html.includes(`data-profile-item="${other.id}"`), `not ${other.id}`);
  assert.ok(!/uppercase tracking-wider[^>]*>MCP servers/.test(html), "the tab names the list: no section label");
  assert.ok(!html.includes("Searching all kinds") && !html.includes("data-searching"), "not searching");

  // Every row, each under its own tab.
  const rows = everyTab();
  for (const entry of ITEMS) rowOf(rows, entry.id);

  // A user row: name, meta and description, no badge, on, full menu.
  const user = rowOf(rows, USER.id);
  assert.ok(user.includes('title="jira-cloud"') && /\btruncate\b/.test(user), "the name truncates with its tooltip");
  assert.ok(user.includes("stdio · Jira issues, sprints and boards") && user.includes("line-clamp-1"), "one clamped line");
  assert.ok(!user.includes("rounded-md border border-neutral-700/80 px-1.5"), "no badge for the user's own");
  assert.ok(/role="switch" aria-checked="true" aria-label="Turn off jira-cloud"/.test(user), "the switch says what it does");
  assert.ok(!/disabled=""/.test(switchOf(user)), "and works");
  assert.ok(user.includes("More actions for jira-cloud"), "its menu");

  // Off, and off by stash: dimmed, and turning on.
  const off = rowOf(rows, OFF.id);
  assert.ok(/opacity-55/.test(off) && off.includes("(off)"), "an off row is dimmed and says so");
  assert.ok(/aria-checked="false" aria-label="Turn on serena"/.test(off));
  assert.ok(switchOf(rowOf(rows, STASHED.id)).includes("set aside by Orquester"), "a stashed row's switch says where it went");

  // Locked: a lock, the switch disabled with its reason, no menu but its place held.
  const locked = rowOf(rows, LOCKED.id);
  assert.ok(locked.includes("(locked)") && locked.includes('title="Locked — Orquester manages this"'), "a lock with its reason");
  assert.ok(/disabled=""/.test(switchOf(locked)), "the switch is disabled");
  assert.ok(/<span class="inline-flex shrink-0" title="Locked — Orquester manages this">/.test(locked), "its tooltip on the wrapper");
  assert.ok(locked.includes(">Orquester</span>"), "its source badge");
  assert.ok(locked.includes("More actions for agent-hook.sh"), "a path to copy still gives it a menu");

  // Inherited: badge, disabled switch saying where to manage it, and the affordance.
  const inherited = rowOf(rows, INHERITED.id);
  assert.ok(inherited.includes(">From Claude</span>"), "the source badge");
  assert.ok(inherited.includes('title="Manage in Claude"') && /disabled=""/.test(switchOf(inherited)));
  assert.ok(/<button[^>]*>Manage in Claude<svg/.test(inherited), "a Manage in Claude button");

  // Plugin-provided with nothing to offer: its menu's place held.
  const plugin = rowOf(rows, PLUGIN_HOOK.id);
  assert.ok(plugin.includes('title="Managed by plugin superpowers"'));
  assert.ok(!plugin.includes("More actions") && /<span aria-hidden="true" class="shrink-0 w-7"><\/span>/.test(plugin), "the menu's place held");
  assert.ok(/shrink-\[100\]/.test(plugin), "the badge shrinks first");

  // Warnings: amber chips, a Trust action where there is one.
  const untrusted = rowOf(rows, UNTRUSTED.id);
  assert.ok(untrusted.includes("Not trusted by Codex") && /text-warn/.test(untrusted), "an amber warning chip");
  assert.ok(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>[\s\S]*?Trust<\/button>/.test(untrusted), "with Trust");
  const cache = rowOf(rows, CACHE.id);
  assert.ok(cache.includes("Plugin cache missing") && !cache.includes(">Trust<"), "a warning without an action has no button");

  // The footer.
  assert.ok(/<button type="button" class="app-no-drag flex w-full rounded-md/.test(html), "a full-width + Add trigger");
  assert.ok(html.includes("to Claude&#x27;s profile") && html.includes("Changes apply to new sessions"), "Add, and the hint");
  assert.ok(html.includes('<div role="status" class="sr-only"></div>') && html.includes('<div role="alert" class="sr-only"></div>'), "live regions, always mounted");
}

// ---------------------------------------------------------------------------
// The picker collapses on a narrow panel; OpenCode's hint
// ---------------------------------------------------------------------------

{
  const narrow = view(viewProps({ width: 280 }));
  assert.ok(narrow.includes('data-agent-picker="dropdown"') && !narrow.includes('data-agent-picker="segmented"'), "280 px: one dropdown");
  assert.ok(/<span class="sr-only">Agent: <\/span><span class="min-w-0 flex-1 truncate">Claude<\/span>/.test(narrow), "naming the agent");
  const opencode = view(viewProps({ agent: "opencode", snap: snapshot("opencode", { items: [] }) }));
  assert.ok(opencode.includes("OpenCode servers restart when idle"), "OpenCode's hint");
  assert.deepEqual([...tabsOf(opencode).keys()], ["mcp", "skill", "plugin", "command"], "only OpenCode's kinds");
}

// ---------------------------------------------------------------------------
// The kind tabs: wrapping at every width, search across kinds, the remembered
// tab, a 0-count kind, the keyboard
// ---------------------------------------------------------------------------

{
  // The narrowest dock (260 px) and the phones (360/390 px) wrap the tabs; none is ever cut off.
  for (const [variant, width] of [["docked", 260], ["docked", 320], ["docked", 560], ["sheet", 352], ["sheet", 382]] as const) {
    const html = view(viewProps({ variant, width }));
    const tablist = tablistOf(html);
    assert.ok(/class="flex flex-wrap transition-opacity gap-1(\.5)?[ "]/.test(tablist), `${variant} ${width}: the tabs wrap`);
    assert.ok(!/overflow-x-auto|flex-nowrap|mask-image|\btruncate\b/.test(tablist), `${variant} ${width}: nothing scrolls or clips`);
    assert.equal(tabsOf(html).size, 6, `${variant} ${width}: all six tabs`);
    for (const [kind, tab] of tabsOf(html)) {
      assert.ok(/\bshrink-0\b/.test(tab) && /\bwhitespace-nowrap\b/.test(tab), `${variant} ${width}: ${kind} keeps its size`);
      assert.ok(new RegExp(`\\b${variant === "sheet" ? "h-10" : "h-8"}\\b`).test(tab), `${variant} ${width}: ${kind}'s target`);
    }
  }
  // The widest tab fits the narrowest dock: "Marketplaces" with its icon and a
  // two-digit badge is about 150 px at 12 px (DejaVu Sans, the widest system
  // font), and the 260 px dock leaves 236 px inside its padding.
  const narrow = view(viewProps({ width: 260 }));
  assert.ok(narrow.includes('data-agent-picker="dropdown"') && narrow.indexOf("data-profile-instructions") < narrow.indexOf('role="tablist"'), "260 px: the card still above the tabs");

  // Searching: every kind's matches, grouped under their labels; the tabs step back and say so.
  const searching = view(viewProps({ query: "e", remembered: "skill" }));
  const tabs = tabsOf(searching);
  assert.ok(/data-searching=""[^>]*class="[^"]*opacity-60/.test(tablistOf(searching)), "the tabs are dimmed");
  assert.ok(/aria-selected="true"/.test(tabs.get("skill")!) && !/bg-neutral-100 text-neutral-900/.test(tablistOf(searching)), "the tab stays selected, unfilled");
  assert.ok(searching.includes("Searching all kinds — clear the search to return to Skills"), "and a line says the search looks past it");
  assert.ok(!searching.includes('role="tabpanel"') && searching.includes('aria-label="Search results in Claude&#x27;s profile"'), "the list is the results, not a tab");
  const sections = ["MCP servers", "Skills", "Plugins", "Hooks", "Commands"].map((label) => searching.indexOf(`<section aria-label="${label}"`));
  assert.ok(sections.every((at, index) => at > 0 && (index === 0 || at > sections[index - 1]!)), "matches of every kind, in kind order");
  assert.ok(/uppercase tracking-wider[^>]*>MCP servers<span[^>]*>2<\/span>/.test(searching), "each under its section label, counted");
  assert.ok(searching.includes("data-profile-instructions"), "the instructions card stays");
  const narrowed = view(viewProps({ query: "lint", remembered: "skill" }));
  assert.ok(narrowed.includes(`data-profile-item="${UNTRUSTED.id}"`) && !narrowed.includes(`data-profile-item="${INHERITED.id}"`), "a hook found from the Skills tab");
  const cleared = view(viewProps({ query: "  ", remembered: "skill" }));
  assert.ok(cleared.includes('role="tabpanel"') && !cleared.includes("Searching all kinds"), "a blank search is back on the tab");
  assert.ok(cleared.includes(`data-profile-item="${INHERITED.id}"`) && !cleared.includes(`data-profile-item="${USER.id}"`), "the Skills tab's rows");

  // The remembered tab: shown when the agent has the kind, else the agent's first.
  const hooks = view(viewProps({ remembered: "hook" }));
  assert.ok(/aria-selected="true"[^>]*tabindex="0"[^>]*data-kind-tab="hook"[^>]*bg-neutral-100 text-neutral-900/.test(hooks), "the Hooks tab, remembered, is shown filled");
  for (const entry of [LOCKED, PLUGIN_HOOK, UNTRUSTED]) assert.ok(hooks.includes(`data-profile-item="${entry.id}"`), `${entry.id} under Hooks`);
  assert.ok(!hooks.includes(`data-profile-item="${USER.id}"`), "not MCP's");
  const opencode = view(viewProps({ agent: "opencode", snap: snapshot("opencode", { items: [INHERITED] }), remembered: "hook" }));
  assert.ok(/aria-selected="true"[^>]*data-kind-tab="mcp"/.test(opencode), "a kind OpenCode lacks falls back to its first tab");
  assert.ok(opencode.includes("No MCP servers yet."), "and that tab's empty state");

  // A 0-count kind, shown: its empty state with its Add, the card and the tabs still there.
  const marketplaces = view(viewProps({ remembered: "marketplace" }));
  assert.ok(/aria-selected="true"[^>]*data-kind-tab="marketplace"/.test(marketplaces), "the empty tab can be shown");
  assert.ok(/Marketplaces<span data-kind-count=""[^>]*bg-neutral-900 text-neutral-100[^>]*><span class="sr-only">, <\/span>0</.test(marketplaces), "filled, counting 0");
  assert.ok(marketplaces.includes("No marketplaces yet.") && /Add marketplace<\/button>/.test(marketplaces), "its own empty state and Add");
  assert.ok(marketplaces.includes("data-profile-instructions") && tabsOf(marketplaces).size === 6, "the card and every tab stay");

  // The keyboard: ←/→ wrap, Home/End jump; nothing else (Escape included) is the tabs'.
  assert.equal(kindTabKeyTarget("ArrowRight", 5, 6), 0);
  assert.equal(kindTabKeyTarget("ArrowLeft", 0, 6), 5);
  assert.equal(kindTabKeyTarget("ArrowRight", 2, 6), 3);
  assert.equal(kindTabKeyTarget("Home", 4, 6), 0);
  assert.equal(kindTabKeyTarget("End", 1, 6), 5);
  for (const key of ["Escape", "Enter", " ", "ArrowUp", "ArrowDown", "Tab", "a"]) assert.equal(kindTabKeyTarget(key, 2, 6), null, key);
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

{
  const loading = view(viewProps({ snap: null, status: "loading" }));
  assert.ok(loading.includes('aria-label="Loading the profile"') && loading.includes("animate-pulse"), "a loading skeleton");
  assert.ok(loading.includes('aria-busy="true"'), "the list is busy");
  assert.ok(!loading.includes('role="tablist"') && !loading.includes("data-profile-instructions"), "no tabs without a snapshot");
  assert.ok(/<button class="[^"]*\bw-full\b[^"]*" type="button" disabled="">[\s\S]{0,600}?Add<\/button>/.test(loading), "Add waits for the snapshot");

  const notInstalled = view(viewProps({ agent: "grok", snap: null, status: "error", notInstalled: true }));
  assert.ok(notInstalled.includes("Grok is not installed.") && notInstalled.includes("Install it from Settings → Agents."));

  const error = view(viewProps({ snap: null, status: "error", error: "The daemon did not answer." }));
  assert.ok(error.includes("Couldn&#x27;t load Claude&#x27;s profile") && error.includes("The daemon did not answer."));
  assert.ok(/<button[^>]*>Retry<\/button>/.test(error), "with Retry");

  const emptyKind = view(viewProps({ snap: snapshot("claude", { items: [] }), kind: "mcp" }));
  assert.ok(emptyKind.includes("No MCP servers yet.") && /Add MCP server<\/button>/.test(emptyKind), "an empty kind offers its Add");
  assert.ok(emptyKind.includes("data-profile-instructions"), "the instructions card stays on every tab");

  const codexCommands = view(viewProps({ agent: "codex", snap: snapshot("codex", { items: [] }), kind: "command" }));
  assert.ok(codexCommands.includes("No commands yet.") && !codexCommands.includes("Add command"), "Codex cannot create commands");

  const none = view(viewProps({ snap: snapshot("claude", { items: [] }) }));
  assert.ok(none.includes("No MCP servers yet.") && none.includes("data-profile-instructions"), "nothing at all: the first tab's empty state");
  assert.ok([...tabsOf(none).values()].every((tab) => /<span class="sr-only">, <\/span>0<\/span>/.test(tab)), "every tab counting 0");

  const noMatches = view(viewProps({ query: "zzz" }));
  assert.ok(noMatches.includes("Nothing matches “zzz”"));

  const refreshFailed = view(viewProps({ loadError: "The daemon did not answer." }));
  assert.ok(refreshFailed.includes("The daemon did not answer.") && />Retry<\/button>/.test(refreshFailed) && refreshFailed.includes("data-profile-item"), "a failed refresh keeps the rows, with Retry");
}

{
  const partial = view(
    viewProps({
      snap: snapshot("codex", {
        items: [USER],
        fileErrors: [{ path: "/var/lib/orquester/.codex/config.toml", message: "expected `=` at line 12" }],
        instructions: {
          path: "/var/lib/orquester/.codex/AGENTS.md",
          exists: true,
          bytes: 10,
          lines: 3,
          revision: "i",
          warnings: [{ code: "override", message: "Shadowed by AGENTS.override.md" }]
        }
      }),
      agent: "codex"
    })
  );
  assert.ok(partial.includes('data-profile-file-errors=""') && partial.includes("A file could not be read"), "a partial snapshot's banner");
  assert.ok(partial.includes("/var/lib/orquester/.codex/config.toml") && partial.includes("expected `=` at line 12"), "naming the file and why");
  assert.ok(/data-profile-instructions[\s\S]*?Shadowed by AGENTS\.override\.md/.test(partial), "the instructions warning as a chip");
}

{
  const ok = view(viewProps({ notice: { tone: "ok", text: "Turned off serena. Applies to new sessions." } }));
  assert.ok(ok.includes('data-profile-notice="ok"') && ok.includes('<div role="status" class="sr-only">Turned off serena.'), "an ok notice, read out");
  const bad = view(viewProps({ notice: { tone: "error", text: "It changed on disk; the list was refreshed." } }));
  assert.ok(bad.includes('data-profile-notice="error"') && /text-danger/.test(bad), "a refusal in the danger colour");
  assert.ok(bad.includes('<div role="alert" class="sr-only">It changed on disk'), "read out as an alert");
}

{
  const busy = view(viewProps({ pendingIds: new Set([USER.id]), highlightId: OFF.id }));
  const row = rowOf(busy, USER.id);
  assert.ok(/aria-busy="true"/.test(row) && /animate-spin/.test(row), "a change in flight shows");
  assert.ok(/aria-disabled="true"/.test(switchOf(row)) && !/disabled=""/.test(switchOf(row)), "the switch refuses clicks yet keeps focus");
  assert.ok(/ring-neutral-500\/50/.test(rowOf(busy, OFF.id)), "the saved item is outlined");
}

// ---------------------------------------------------------------------------
// The sheet: 40 px targets, and the questions asked on the row
// ---------------------------------------------------------------------------

{
  const html = view(viewProps({ variant: "sheet", width: 352 }));
  assert.ok(html.includes('data-agent-picker="segmented"'), "a 360 px phone fits the segments");
  const segments = html.match(/<div role="group" aria-label="Agent"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok((segments.match(/<button[^>]*class="[^"]*\bh-10\b/g) ?? []).length === 4, "segments 40 px tall");
  assert.ok([...tabsOf(html).values()].filter((tab) => /class="[^"]*\bh-10\b/.test(tab)).length === 6, "every tab a 40 px target");
  const rows = everyTab({ variant: "sheet", width: 352 });
  const user = rowOf(rows, USER.id);
  assert.ok(/\bh-10\b/.test(switchOf(user)) && /\bw-12\b/.test(switchOf(user)), "the switch's target is 40 px");
  assert.ok(/<span title="More actions" class="[^"]*\bh-10 w-10\b/.test(user), "so is the menu's");
  assert.ok(/<button[^>]*class="[^"]*\bmin-h-10\b[^"]*"[^>]*>Manage in Claude/.test(rowOf(rows, INHERITED.id)), "and Manage in");
  const trust = rowOf(rows, UNTRUSTED.id).match(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>/)?.[0] ?? "";
  assert.ok(/\bh-10\b/.test(trust), "and Trust");
  assert.ok(/min-h-14/.test(html.match(/data-profile-instructions[^>]*class="[^"]*"/)?.[0] ?? ""), "the instructions card");
  assert.ok(/inline-flex w-full items-center justify-center gap-2 rounded-md bg-neutral-200 px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 h-10/.test(html), "and + Add");

  const narrow = view(viewProps({ variant: "sheet", width: 300 }));
  assert.ok(/data-agent-picker="dropdown" class="[^"]*\bh-10\b/.test(narrow), "a narrow sheet's dropdown is 40 px");
}

{
  const deleting = view(viewProps({ variant: "sheet", confirming: { itemId: OFF.id, kind: "delete" } }));
  const row = rowOf(deleting, OFF.id);
  assert.ok(row.includes('role="group" aria-label="Delete serena"'), "Delete asks on the row");
  assert.ok(/<button[^>]*>Cancel<\/button>/.test(row) && /bg-danger-600[^>]*>Delete<\/button>/.test(row), "Cancel and a red Delete");
  assert.ok(!rowOf(deleting, USER.id).includes("aria-label=\"Delete"), "only that row asks");

  const conflict = view(viewProps({ variant: "sheet", confirming: { itemId: USER.id, kind: "conflict", toAgent: "codex" } }));
  const asked = rowOf(conflict, USER.id);
  assert.ok(asked.includes("Codex already has <span"), "a copy's collision asks on the row");
  for (const label of ["Replace", "Keep both", "Cancel"]) assert.ok(asked.includes(`>${label}</button>`), label);
}

// ---------------------------------------------------------------------------
// What the adapters really put in `meta` and `warnings`
// ---------------------------------------------------------------------------

{
  const offNote =
    'Turning it off adds it to deniedMcpServers in settings.json, which also blocks a project MCP server named "context7".';
  const claudeMcp = item({
    id: "mcp:context7",
    description: undefined,
    meta: { transport: "http", target: "https://mcp.context7.com/mcp", offNote }
  });
  const claudeHook = item({
    id: "hook:PreToolUse:1111111111111111",
    kind: "hook",
    name: "~/.claude/hooks/guard.sh",
    description: "PreToolUse · Bash",
    meta: { event: "PreToolUse", type: "command", matcher: "Bash" }
  });
  const unreadable = item({
    id: "skill:broken",
    kind: "skill",
    editable: false,
    path: "/var/lib/orquester/.claude/skills/broken",
    warnings: [{ code: "unreadable", message: "SKILL.md frontmatter is not valid YAML", action: "open-file" }]
  });
  const noPath = item({
    id: "hook:Stop:2222222222222222",
    kind: "hook",
    path: undefined,
    warnings: [{ code: "config-toml-hook", message: "Defined in config.toml: change it in that file.", action: "open-file" }]
  });
  for (const variant of ["docked", "sheet"] as const) {
    const html = everyTab({ variant, snap: snapshot("claude", { items: [claudeMcp, claudeHook, unreadable, noPath] }) });

    const mcp = rowOf(html, claudeMcp.id);
    assert.ok(mcp.includes("http · https://mcp.context7.com/mcp"), `${variant}: the transport and the target as the second line`);
    assert.ok(!/<p[^>]*>[^<]*deniedMcpServers/.test(mcp), `${variant}: the off-switch caveat is not a second-line fact`);
    assert.ok(
      /role="switch"[^>]*title="On — loaded by new sessions\. Turning it off adds it to deniedMcpServers[^"]*also blocks a project MCP server/.test(
        mcp.replace(/&quot;/g, '"')
      ),
      `${variant}: it is the switch's tooltip, where it is about`
    );

    const hook = rowOf(html, claudeHook.id);
    assert.ok(hook.includes(">PreToolUse · Bash</p>"), `${variant}: a hook's event and matcher said once, not "command · …" twice`);

    const broken = rowOf(html, unreadable.id);
    const copyPath = broken.match(/<button[^>]*title="Copy \/var\/lib\/orquester\/\.claude\/skills\/broken"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    assert.ok(copyPath.includes("Copy path"), `${variant}: an open-file warning offers the file's path`);
    assert.ok(variant === "docked" ? /\bh-6\b/.test(copyPath) : /\bh-10\b/.test(copyPath), `${variant}: sized for the variant`);
    assert.ok(!rowOf(html, noPath.id).includes("Copy path"), `${variant}: no path, no button`);
  }
}

// ---------------------------------------------------------------------------
// Every control shows a focus ring, in every state (spec §7.5)
// ---------------------------------------------------------------------------

{
  const states = [
    viewProps({ loadError: "The daemon did not answer.", notice: { tone: "ok", text: "Saved." } }),
    viewProps({ variant: "sheet", loadError: "The daemon did not answer." }),
    viewProps({ snap: null, status: "error", error: "offline" }),
    viewProps({ snap: snapshot("claude", { items: [] }), kind: "mcp" }),
    viewProps({ variant: "sheet", confirming: { itemId: OFF.id, kind: "delete" } }),
    viewProps({ width: 280 }),
    viewProps({ query: "e" }),
    viewProps({ variant: "sheet", width: 352, remembered: "hook" }),
    viewProps({ width: 260, remembered: "marketplace" })
  ];
  for (const props of states) {
    const html = view(props);
    for (const button of html.match(/<button\b[^>]*>/g) ?? []) {
      assert.match(button, /focus-visible:ring/, `a focus ring on ${button}`);
    }
  }
}

// ---------------------------------------------------------------------------
// A row on its own: the menu's items
// ---------------------------------------------------------------------------

{
  // The menu's items live in its portal (closed in a static render); render
  // them as the sheet would, through the row's own props.
  const props: ProfileItemRowProps = {
    item: USER,
    agent: "claude",
    variant: "docked",
    busy: false,
    highlighted: false,
    copyTargets: ["codex", "opencode"],
    confirm: null,
    onToggle: NOOP,
    onEdit: NOOP,
    onCopyTo: NOOP,
    onCopyPath: NOOP,
    onDelete: NOOP,
    onTrust: NOOP,
    onManageIn: NOOP,
    onConfirmDelete: NOOP,
    onResolveConflict: NOOP,
    onCancelConfirm: NOOP
  };
  const html = render(createElement(ProfileItemRow, props));
  assert.ok(html.startsWith('<div data-profile-item="mcp:jira-cloud"'), "keyed by its id");
  assert.ok(/<button type="button" class="app-no-drag inline-flex shrink-0 rounded-md/.test(html), "the menu trigger is a fixed-size button");
  const noActions = render(
    createElement(ProfileItemRow, {
      ...props,
      item: { ...PLUGIN_HOOK },
      copyTargets: []
    })
  );
  assert.ok(!noActions.includes("More actions"), "nothing to offer, no menu");
}

// ---------------------------------------------------------------------------
// Nothing clipped in the narrowest dock or on a phone (the screenshot pass)
// ---------------------------------------------------------------------------

{
  const grokMd = {
    code: "dead-grok-md",
    message: "~/.grok/GROK.md is never read by Grok. Move its text into AGENTS.md."
  };
  const orquesterHook = item({
    id: "hook:Stop:3333333333333333",
    kind: "hook",
    name: "'/var/lib/orquester/daemon/hooks/agent-hook.sh' grok Stop",
    description: "Stop",
    toggleable: false,
    editable: false,
    deletable: false,
    locked: true,
    source: { type: "orquester", label: "Orquester" },
    meta: { event: "Stop", file: "orquester.json", timeout: "10 s" }
  });
  const inherited = { ...INHERITED, warnings: [{ code: "long", message: "A warning long enough to need a second line on a phone" }] };
  const snap = snapshot("opencode", {
    items: [orquesterHook, inherited],
    instructions: { ...snapshot("opencode").instructions, warnings: [grokMd] }
  });
  const narrow = everyTab({ agent: "opencode", snap, width: 260 });
  assert.deepEqual([...tabsOf(narrow).keys()], ["mcp", "skill", "plugin", "command", "hook"], "a hook OpenCode should not have gets a tab after its kinds");

  assert.ok(narrow.includes('placeholder="Search profile…"'), "a search placeholder the 260 px dock holds");
  assert.ok(narrow.includes('aria-label="Search OpenCode&#x27;s profile"'), "its name still says whose");

  const hint = narrow.match(/<p class="[^"]*">Applies to new sessions · OpenCode servers restart when idle<\/p>/)?.[0] ?? "";
  assert.ok(hint.length > 0 && !/\btruncate\b/.test(hint) && /text-balance/.test(hint), "OpenCode's hint wraps, never clips");

  const card = narrow.match(/<button[^>]*data-profile-instructions=""[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.ok(!card.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a narrow panel's card drops the file icon");
  assert.ok(/\bw-6\b/.test(card), "and narrows its chevron");
  const wide = view(viewProps({ agent: "opencode", snap, width: 400 }));
  const wideCard = wide.match(/<button[^>]*data-profile-instructions=""[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.ok(wideCard.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a wide one keeps it");

  // Warning chips wrap: a phone has no tooltip to read the rest in.
  for (const html of [card, rowOf(narrow, inherited.id)]) {
    const chip = html.match(/<span class="inline-flex min-w-0 max-w-full items-start[^"]*text-warn">[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
    assert.ok(chip.length > 0 && /break-words/.test(chip) && !/\btruncate\b/.test(chip), "a warning chip wraps");
  }

  // A hook named by its command: the end of the path, the whole in the tooltip,
  // and its line reads event first, like every agent's.
  const hook = rowOf(narrow, orquesterHook.id);
  assert.ok(hook.includes(`title="${orquesterHook.name.replace(/'/g, "&#x27;")}"`), "the whole command in the tooltip");
  assert.ok(hook.includes(">&#x27;…/agent-hook.sh&#x27; grok Stop</span>"), "the part that tells hooks apart");
  assert.ok(hook.includes(">Stop · timeout 10 s · orquester.json</p>"), "event first");
  // A dock squeezed below its minimum (a 768 px tablet with the sidebar open)
  // clips the name line, so the badge's floor never overlaps the switch.
  assert.ok(/<div class="flex min-w-0 items-center gap-1\.5 overflow-hidden">/.test(hook), "the name line clips its badge");

  // The sheet: the Manage-in footer tucks under the 40 px targets above it.
  const sheet = everyTab({ agent: "opencode", snap, variant: "sheet", width: 352 });
  assert.ok(/<div class="flex flex-wrap items-center gap-1\.5 px-3 -mt-2 pb-1">/.test(rowOf(sheet, inherited.id)), "no gap under the row");
}

console.log("agent-profile render checks passed");
