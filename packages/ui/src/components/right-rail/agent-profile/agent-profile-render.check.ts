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
  type ProfileItem
} from "@orquester/api";

import { AgentProfilePanelView, type AgentProfilePanelViewProps, type ProfileItemActions } from "./AgentProfilePanelView";
import {
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  filterProfileItems,
  groupProfileItems,
  profileKindChips,
  type ProfileKindFilter
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
    kind?: ProfileKindFilter;
    query?: string;
  } & Partial<AgentProfilePanelViewProps> = {}
): AgentProfilePanelViewProps {
  const agent = options.agent ?? "claude";
  const snap = options.snap === undefined ? snapshot(agent) : options.snap;
  const kind = options.kind ?? "all";
  const query = options.query ?? "";
  const items = snap?.items ?? [];
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
    chips: profileKindChips(agent, items),
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

  // Search and the chips.
  assert.ok(html.includes('aria-label="Search Claude&#x27;s profile"'));
  const chips = html.match(/<div role="group" aria-label="Filter by kind"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(/overflow-x-auto/.test(chips) && /flex-nowrap/.test(chips), "one scrolling row that never wraps");
  assert.ok(chips.includes("mask-image"), "with its edge fades");
  assert.ok(/aria-pressed="true"[^>]*>[\s\S]*?All[\s\S]*?>9</.test(chips), "All is pressed, with the total");
  assert.ok(/MCP<span[^>]*>2</.test(chips) && /Hooks<span[^>]*>3</.test(chips), "each kind with its count");
  assert.ok(/Marketplaces<span[^>]*>0</.test(chips), "an empty kind keeps its chip");

  // The instructions card.
  assert.ok(html.includes('data-profile-instructions=""'), "the instructions card");
  assert.ok(html.includes("CLAUDE.md") && html.includes("42 lines · edited 2h ago"), "file, lines, edited ago");

  // Groups in kind order.
  const order = ["MCP servers", "Skills", "Plugins", "Hooks", "Commands"].map((label) => html.indexOf(`aria-label="${label}"`));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!)), "sections in AGENT_PROFILE_KINDS order");
  assert.ok(!html.includes('aria-label="Marketplaces"'), "no section for an empty kind");

  // A user row: name, meta and description, no badge, on, full menu.
  const user = rowOf(html, USER.id);
  assert.ok(user.includes('title="jira-cloud"') && /\btruncate\b/.test(user), "the name truncates with its tooltip");
  assert.ok(user.includes("stdio · Jira issues, sprints and boards") && user.includes("line-clamp-1"), "one clamped line");
  assert.ok(!user.includes("rounded-md border border-neutral-700/80 px-1.5"), "no badge for the user's own");
  assert.ok(/role="switch" aria-checked="true" aria-label="Turn off jira-cloud"/.test(user), "the switch says what it does");
  assert.ok(!/disabled=""/.test(switchOf(user)), "and works");
  assert.ok(user.includes("More actions for jira-cloud"), "its menu");

  // Off, and off by stash: dimmed, and turning on.
  const off = rowOf(html, OFF.id);
  assert.ok(/opacity-55/.test(off) && off.includes("(off)"), "an off row is dimmed and says so");
  assert.ok(/aria-checked="false" aria-label="Turn on serena"/.test(off));
  assert.ok(switchOf(rowOf(html, STASHED.id)).includes("set aside by Orquester"), "a stashed row's switch says where it went");

  // Locked: a lock, the switch disabled with its reason, no menu but its place held.
  const locked = rowOf(html, LOCKED.id);
  assert.ok(locked.includes("(locked)") && locked.includes('title="Locked — Orquester manages this"'), "a lock with its reason");
  assert.ok(/disabled=""/.test(switchOf(locked)), "the switch is disabled");
  assert.ok(/<span class="inline-flex shrink-0" title="Locked — Orquester manages this">/.test(locked), "its tooltip on the wrapper");
  assert.ok(locked.includes(">Orquester</span>"), "its source badge");
  assert.ok(locked.includes("More actions for agent-hook.sh"), "a path to copy still gives it a menu");

  // Inherited: badge, disabled switch saying where to manage it, and the affordance.
  const inherited = rowOf(html, INHERITED.id);
  assert.ok(inherited.includes(">From Claude</span>"), "the source badge");
  assert.ok(inherited.includes('title="Manage in Claude"') && /disabled=""/.test(switchOf(inherited)));
  assert.ok(/<button[^>]*>Manage in Claude<svg/.test(inherited), "a Manage in Claude button");

  // Plugin-provided with nothing to offer: its menu's place held.
  const plugin = rowOf(html, PLUGIN_HOOK.id);
  assert.ok(plugin.includes('title="Managed by plugin superpowers"'));
  assert.ok(!plugin.includes("More actions") && /<span aria-hidden="true" class="shrink-0 w-7"><\/span>/.test(plugin), "the menu's place held");
  assert.ok(/shrink-\[100\]/.test(plugin), "the badge shrinks first");

  // Warnings: amber chips, a Trust action where there is one.
  const untrusted = rowOf(html, UNTRUSTED.id);
  assert.ok(untrusted.includes("Not trusted by Codex") && /text-warn/.test(untrusted), "an amber warning chip");
  assert.ok(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>[\s\S]*?Trust<\/button>/.test(untrusted), "with Trust");
  const cache = rowOf(html, CACHE.id);
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
  const chips = opencode.match(/aria-label="Filter by kind"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(!chips.includes("Hooks") && !chips.includes("Marketplaces"), "only OpenCode's kinds");
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

{
  const loading = view(viewProps({ snap: null, status: "loading" }));
  assert.ok(loading.includes('aria-label="Loading the profile"') && loading.includes("animate-pulse"), "a loading skeleton");
  assert.ok(loading.includes('aria-busy="true"'), "the list is busy");
  assert.ok(!loading.includes("Filter by kind") && !loading.includes("data-profile-instructions"), "no filters without a snapshot");
  assert.ok(/<button class="[^"]*\bw-full\b[^"]*" type="button" disabled="">[\s\S]{0,600}?Add<\/button>/.test(loading), "Add waits for the snapshot");

  const notInstalled = view(viewProps({ agent: "grok", snap: null, status: "error", notInstalled: true }));
  assert.ok(notInstalled.includes("Grok is not installed.") && notInstalled.includes("Install it from Settings → Agents."));

  const error = view(viewProps({ snap: null, status: "error", error: "The daemon did not answer." }));
  assert.ok(error.includes("Couldn&#x27;t load Claude&#x27;s profile") && error.includes("The daemon did not answer."));
  assert.ok(/<button[^>]*>Retry<\/button>/.test(error), "with Retry");

  const emptyKind = view(viewProps({ snap: snapshot("claude", { items: [] }), kind: "mcp" }));
  assert.ok(emptyKind.includes("No MCP servers yet.") && /Add MCP server<\/button>/.test(emptyKind), "an empty kind offers its Add");
  assert.ok(!emptyKind.includes("data-profile-instructions"), "the instructions card stays out of a filtered list");

  const codexCommands = view(viewProps({ agent: "codex", snap: snapshot("codex", { items: [] }), kind: "command" }));
  assert.ok(codexCommands.includes("No commands yet.") && !codexCommands.includes("Add command"), "Codex cannot create commands");

  const none = view(viewProps({ snap: snapshot("claude", { items: [] }) }));
  assert.ok(none.includes("Claude has no MCP servers, skills or plugins yet.") && none.includes("data-profile-instructions"));

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
  const chips = html.match(/<div role="group" aria-label="Filter by kind"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok((chips.match(/<button[^>]*class="[^"]*\bh-10\b/g) ?? []).length === 7, "every chip a 40 px target");
  const user = rowOf(html, USER.id);
  assert.ok(/\bh-10\b/.test(switchOf(user)) && /\bw-12\b/.test(switchOf(user)), "the switch's target is 40 px");
  assert.ok(/<span title="More actions" class="[^"]*\bh-10 w-10\b/.test(user), "so is the menu's");
  assert.ok(/<button[^>]*class="[^"]*\bmin-h-10\b[^"]*"[^>]*>Manage in Claude/.test(rowOf(html, INHERITED.id)), "and Manage in");
  const trust = rowOf(html, UNTRUSTED.id).match(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>/)?.[0] ?? "";
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
    const html = view(viewProps({ variant, snap: snapshot("claude", { items: [claudeMcp, claudeHook, unreadable, noPath] }) }));

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

console.log("agent-profile render checks passed");
