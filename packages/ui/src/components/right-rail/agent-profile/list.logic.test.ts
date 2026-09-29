import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentProfileSnapshot, ProfileItem } from "@orquester/api";

import {
  addMenuKinds,
  AGENT_PICKER_SEGMENTED_MIN_WIDTH,
  agentPickerLayout,
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  effectiveKindTab,
  emptyKindTitle,
  fileNameOf,
  filterProfileItems,
  groupProfileItems,
  instructionsLine,
  isAgentNotInstalled,
  isProfileSearchActive,
  manageInAgent,
  matchesProfileQuery,
  profileItemDisplayName,
  profileItemKindOfId,
  profileItemMetaParts,
  profileItemSecondLine,
  profileKindTabs,
  switchDisabledReason,
  switchLabel,
  switchTitle
} from "./list.logic.ts";

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
    revision: "r",
    warnings: [],
    ...overrides
  };
}

const ITEMS: ProfileItem[] = [
  item({ id: "mcp:jira", description: "Jira Cloud tools" }),
  item({ id: "mcp:Atlas" }),
  item({ id: "skill:review", kind: "skill", description: "Review the diff" }),
  item({ id: "hook:PreToolUse:abc", kind: "hook", name: "PreToolUse", meta: { event: "PreToolUse", matcher: "Bash" } }),
  item({ id: "command:pr", kind: "command" }),
  item({ id: "plugin:superpowers", kind: "plugin", source: { type: "plugin", label: "Plugin · superpowers", pluginId: "superpowers" } })
];

function snapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    agent: "claude",
    installed: true,
    revision: "r",
    instructions: { path: "/h/.claude/CLAUDE.md", exists: true, bytes: 1, lines: 1, revision: "", warnings: [] },
    items: ITEMS,
    fileErrors: [],
    readAt: "",
    ...overrides
  };
}

describe("kind tabs", () => {
  it("the agent's own kinds in AGENT_PROFILE_KINDS order, each counted — zero included, no All", () => {
    assert.deepEqual(
      profileKindTabs("claude", ITEMS).map((tab) => [tab.id, tab.label, tab.count]),
      [
        ["mcp", "MCP", 2],
        ["skill", "Skills", 1],
        ["plugin", "Plugins", 1],
        ["marketplace", "Marketplaces", 0],
        ["hook", "Hooks", 1],
        ["command", "Commands", 1]
      ]
    );
  });

  it("only the kinds that agent has: OpenCode has no marketplaces or hooks", () => {
    assert.deepEqual(
      profileKindTabs("opencode", []).map((tab) => tab.id),
      ["mcp", "skill", "plugin", "command"]
    );
  });

  it("a kind the agent should not have (another daemon version) gets a tab while it has items, after the rest", () => {
    assert.deepEqual(
      profileKindTabs("opencode", [item({ id: "hook:x", kind: "hook" }), item({ id: "mcp:a" })]).map((tab) => [tab.id, tab.count]),
      [
        ["mcp", 1],
        ["skill", 0],
        ["plugin", 0],
        ["command", 0],
        ["hook", 1]
      ]
    );
  });

  it("shows the remembered tab when it is one of the agent's, else the agent's first", () => {
    const opencode = profileKindTabs("opencode", []);
    assert.equal(effectiveKindTab(opencode, "skill"), "skill");
    assert.equal(effectiveKindTab(profileKindTabs("claude", []), "command"), "command");
    assert.equal(effectiveKindTab(opencode, "hook"), "mcp", "a kind the agent lacks falls back to its first");
    assert.equal(
      effectiveKindTab(profileKindTabs("opencode", [item({ id: "hook:x", kind: "hook" })]), "hook"),
      "hook",
      "unless it has items to show under it"
    );
    for (const junk of [null, undefined, "all", "MCP", "", 3, {}, ["skill"]]) {
      assert.equal(effectiveKindTab(profileKindTabs("codex", ITEMS), junk), "mcp", String(junk));
    }
  });

  it("reads a saved item's kind off its id", () => {
    assert.equal(profileItemKindOfId("mcp:jira-cloud"), "mcp");
    assert.equal(profileItemKindOfId("hook:PreToolUse:0123456789abcdef"), "hook");
    assert.equal(profileItemKindOfId("plugin:superpowers@claude-plugins-official"), "plugin");
    for (const id of ["", "mcp", ":mcp", "agent:x", "instructions"]) assert.equal(profileItemKindOfId(id), null, id);
  });

  it("+ Add lists the shown tab's kind first, and still every creatable kind", () => {
    assert.deepEqual(addMenuKinds(["mcp", "skill", "plugin", "marketplace", "hook"], "hook"), [
      "hook",
      "mcp",
      "skill",
      "plugin",
      "marketplace"
    ]);
    assert.deepEqual(addMenuKinds(["mcp", "skill"], "mcp"), ["mcp", "skill"]);
    assert.deepEqual(addMenuKinds(["mcp", "skill"], "command"), ["mcp", "skill"], "a tab that cannot be created keeps the order");
  });
});

describe("filtering and grouping", () => {
  it("the search matches every word in the name, description, source or meta, any case", () => {
    assert.ok(matchesProfileQuery(ITEMS[0]!, "JIRA cloud"));
    assert.ok(!matchesProfileQuery(ITEMS[0]!, "jira review"));
    assert.ok(matchesProfileQuery(ITEMS[5]!, "superpowers"), "the source label");
    assert.ok(matchesProfileQuery(ITEMS[3]!, "bash"), "the meta");
    assert.ok(matchesProfileQuery(ITEMS[0]!, "   "), "blank matches all");
  });

  it("shows the tab's kind; a search looks across every kind, whatever the tab", () => {
    assert.deepEqual(
      filterProfileItems(ITEMS, { kind: "mcp", query: "" }).map((entry) => entry.id),
      ["mcp:jira", "mcp:Atlas"]
    );
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "hook", query: "   " }).map((entry) => entry.id), [
      "hook:PreToolUse:abc"
    ], "a blank search is no search");
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "mcp", query: "review" }).map((entry) => entry.id), ["skill:review"]);
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "skill", query: "jira" }).map((entry) => entry.id), ["mcp:jira"]);
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "skill", query: "zzz" }), []);
    assert.ok(isProfileSearchActive(" a ") && !isProfileSearchActive("  ") && !isProfileSearchActive(""));
  });

  it("groups in the agent's kind order, each sorted by name, empty kinds left out", () => {
    const groups = groupProfileItems("claude", ITEMS);
    assert.deepEqual(
      groups.map((group) => [group.kind, group.label, group.items.map((entry) => entry.name)]),
      [
        ["mcp", "MCP servers", ["Atlas", "jira"]],
        ["skill", "Skills", ["review"]],
        ["plugin", "Plugins", ["superpowers"]],
        ["hook", "Hooks", ["PreToolUse"]],
        ["command", "Commands", ["pr"]]
      ]
    );
  });

  it("a kind the agent should not have (another daemon version) still shows, after the rest", () => {
    const groups = groupProfileItems("opencode", [item({ id: "hook:x", kind: "hook" }), item({ id: "mcp:a" })]);
    assert.deepEqual(groups.map((group) => group.kind), ["mcp", "hook"]);
  });
});

describe("what the list shows", () => {
  const base = {
    agent: "claude" as const,
    status: "ready" as const,
    snapshot: snapshot(),
    error: null,
    notInstalled: false,
    kind: "skill" as const,
    query: "",
    shown: 3
  };

  it("rows when there are some", () => {
    assert.equal(agentProfileEmptyState(base), null);
  });

  it("not installed wins over everything", () => {
    assert.deepEqual(agentProfileEmptyState({ ...base, notInstalled: true }), { kind: "not-installed", agent: "claude" });
  });

  it("loading, then an error with its message, while there is no snapshot", () => {
    assert.deepEqual(agentProfileEmptyState({ ...base, snapshot: null, status: "loading" }), { kind: "loading" });
    assert.deepEqual(agentProfileEmptyState({ ...base, snapshot: null, status: "idle" }), { kind: "loading" });
    assert.deepEqual(agentProfileEmptyState({ ...base, snapshot: null, status: "error", error: "boom" }), {
      kind: "error",
      message: "boom"
    });
  });

  it("no matches while searching, else the empty tab's own state", () => {
    assert.deepEqual(agentProfileEmptyState({ ...base, shown: 0, query: " jira " }), { kind: "no-matches", query: "jira" });
    assert.deepEqual(agentProfileEmptyState({ ...base, shown: 0, kind: "mcp" }), { kind: "empty-kind", itemKind: "mcp" });
    assert.deepEqual(
      agentProfileEmptyState({ ...base, shown: 0, snapshot: snapshot({ items: [] }) }),
      { kind: "empty-kind", itemKind: "skill" },
      "an agent with nothing at all shows the tab's empty state"
    );
  });

  it("titles an empty kind in words", () => {
    assert.equal(emptyKindTitle("mcp"), "No MCP servers yet.");
    assert.equal(emptyKindTitle("skill"), "No skills yet.");
    assert.equal(emptyKindTitle("marketplace"), "No marketplaces yet.");
  });

  it("knows an agent is not installed from its snapshot, its refusal, or the overview", () => {
    assert.equal(isAgentNotInstalled({ snapshot: snapshot({ installed: false }), errorCode: null, overviewInstalled: true }), true);
    assert.equal(isAgentNotInstalled({ snapshot: snapshot(), errorCode: null, overviewInstalled: false }), false, "the snapshot is fresher");
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: "AGENT_NOT_INSTALLED", overviewInstalled: null }), true);
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: null, overviewInstalled: false }), true);
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: null, overviewInstalled: null }), false);
  });
});

describe("a row's meta line", () => {
  // The `meta` each adapter really sets (apps/daemon/src/agent-profile/adapters/*/index.ts).
  const OFF_NOTE =
    'Turning it off adds it to deniedMcpServers in settings.json, which also blocks a project MCP server named "jira".';

  it("words the facts, and never shows Claude's off-switch caveat as a fact", () => {
    const claudeMcp = item({ id: "mcp:jira", meta: { transport: "stdio", target: "npx -y jira-mcp", offNote: OFF_NOTE } });
    assert.deepEqual(profileItemMetaParts(claudeMcp), ["stdio", "npx -y jira-mcp"]);
    assert.ok(!matchesProfileQuery(claudeMcp, "deniedMcpServers"), "nor searches it");
  });

  it("drops what the description already says, and bare flags", () => {
    const claudeHook = item({
      id: "hook:PreToolUse:1",
      kind: "hook",
      description: "PreToolUse · Bash",
      meta: { event: "PreToolUse", type: "command", matcher: "Bash" }
    });
    assert.deepEqual(profileItemMetaParts(claudeHook), [], "Claude's hook description is its event and matcher");
    const codexHook = item({ id: "hook:Stop:2", kind: "hook", meta: { event: "Stop", timeout: "30s" } });
    assert.deepEqual(profileItemMetaParts(codexHook), ["Stop", "timeout 30s"]);
    const promptHook = item({ id: "hook:Stop:3", kind: "hook", description: "Stop", meta: { event: "Stop", type: "prompt" } });
    assert.deepEqual(profileItemMetaParts(promptHook), ["prompt hook"]);
    const symlinked = item({ id: "skill:x", kind: "skill", meta: { symlink: "true", override: "name-only" } });
    assert.deepEqual(profileItemMetaParts(symlinked), ["skillOverrides: name-only", "symlink"]);
  });

  it("a hook's second line reads alike for every agent: event, matcher, then the rest", () => {
    // As the three adapters send them.
    const claude = item({
      id: "hook:PreToolUse:1",
      kind: "hook",
      description: "PreToolUse · *",
      meta: { event: "PreToolUse", type: "command", matcher: "*" }
    });
    const codex = item({
      id: "hook:PreToolUse:2",
      kind: "hook",
      description: "Matcher: *",
      meta: { event: "PreToolUse", matcher: "*", timeout: "10s" }
    });
    const grok = item({
      id: "hook:Stop:3",
      kind: "hook",
      description: "Stop",
      meta: { event: "Stop", file: "orquester.json", timeout: "10 s" }
    });
    assert.equal(profileItemSecondLine(claude), "PreToolUse · *");
    assert.equal(profileItemSecondLine(codex), "PreToolUse · * · timeout 10s");
    assert.equal(profileItemSecondLine(grok), "Stop · timeout 10 s · orquester.json");
    // Anything else: the meta, then the description.
    const mcp = item({ id: "mcp:x", description: "Jira issues", meta: { transport: "stdio" } });
    assert.equal(profileItemSecondLine(mcp), "stdio · Jira issues");
    const eventless = item({ id: "hook:x", kind: "hook", description: "From the plugin" });
    assert.equal(profileItemSecondLine(eventless), "From the plugin");
  });

  it("a hook's name shows the ends of its absolute paths", () => {
    const hook = (name: string) => profileItemDisplayName({ kind: "hook", name });
    assert.equal(hook("'/var/lib/orquester/daemon/hooks/agent-hook.sh' claude Stop"), "'…/agent-hook.sh' claude Stop");
    assert.equal(hook("/usr/bin/node /opt/x/lint.js --fix"), "…/node …/lint.js --fix");
    assert.equal(hook("python3 $HOME/.claude/hooks/reinject.py"), "python3 $HOME/.claude/hooks/reinject.py", "not absolute");
    assert.equal(hook("~/.claude/hooks/check.sh"), "~/.claude/hooks/check.sh");
    assert.equal(hook("/bin/true"), "…/true");
    assert.equal(profileItemDisplayName({ kind: "mcp", name: "/odd/but/kept" }), "/odd/but/kept", "only hooks");
  });

  it("plugins and marketplaces: a version, where from, how many installed", () => {
    const claudePlugin = item({
      id: "plugin:superpowers@official",
      kind: "plugin",
      name: "superpowers@official",
      meta: { version: "5.0.7", marketplace: "official" }
    });
    assert.deepEqual(profileItemMetaParts(claudePlugin), ["v5.0.7"], "the id already names the marketplace");
    const opencodePlugin = item({ id: "plugin:x", kind: "plugin", meta: { source: "npm", version: "1.2.0", options: "yes" } });
    assert.deepEqual(profileItemMetaParts(opencodePlugin), ["v1.2.0", "npm package", "with options"]);
    const market = item({ id: "marketplace:m", kind: "marketplace", meta: { source: "github:a/b", installedPlugins: "3" } });
    assert.deepEqual(profileItemMetaParts(market), ["github:a/b", "3 installed"]);
    const none = item({ id: "marketplace:n", kind: "marketplace", meta: { source: "/srv/m", installedPlugins: "0", branch: "main" } });
    assert.deepEqual(profileItemMetaParts(none), ["/srv/m", "branch main"]);
    const configCommand = item({ id: "command:c", kind: "command", meta: { in: "config" } });
    assert.deepEqual(profileItemMetaParts(configCommand), ["in the config file"]);
  });

  it("an unknown key from another daemon version still shows, after the known ones", () => {
    assert.deepEqual(profileItemMetaParts(item({ id: "mcp:a", meta: { scope: "user", transport: "http" } })), ["http", "user"]);
  });
});

describe("a row's switch and menu", () => {
  it("its tooltip carries the adapter's off-switch caveat while on", () => {
    const offNote = "Turning it off also blocks a project MCP server named \"jira\".";
    assert.equal(
      switchTitle(item({ id: "mcp:jira", meta: { offNote } })),
      `On — loaded by new sessions. ${offNote}`
    );
    assert.equal(switchTitle(item({ id: "mcp:jira", enabled: false, meta: { offNote } })), "Off — not loaded");
    assert.equal(switchTitle(item({ id: "mcp:jira" })), "On — loaded by new sessions");
  });

  it("says what pressing it does", () => {
    assert.equal(switchLabel({ name: "jira", enabled: true }), "Turn off jira");
    assert.equal(switchLabel({ name: "jira", enabled: false }), "Turn on jira");
  });

  it("explains why it is disabled", () => {
    assert.equal(switchDisabledReason(ITEMS[0]!), null);
    assert.equal(
      switchDisabledReason(item({ id: "hook:o", toggleable: false, locked: true, source: { type: "orquester", label: "Orquester" } })),
      "Locked — Orquester manages this"
    );
    assert.equal(
      switchDisabledReason(item({ id: "skill:s", toggleable: false, locked: true, source: { type: "cli", label: "CLI" } })),
      "Locked — the agent's CLI manages this"
    );
    assert.equal(
      switchDisabledReason(
        item({ id: "skill:x", toggleable: false, source: { type: "inherited", label: "From Claude", ownerAgent: "claude" } })
      ),
      "Manage in Claude"
    );
    assert.equal(
      switchDisabledReason(item({ id: "hook:p", toggleable: false, source: { type: "plugin", label: "Plugin · superpowers" } })),
      "Managed by plugin superpowers"
    );
    assert.equal(
      switchDisabledReason(item({ id: "skill:b", toggleable: false, source: { type: "bundled", label: "Bundled" } })),
      "Bundled with the agent — can't be turned off here"
    );
  });

  it("copies only copyable kinds, to the other installed agents that have the kind", () => {
    const installed = (agent: string) => (agent === "grok" ? false : agent === "opencode" ? null : true);
    assert.deepEqual(copyTargets({ kind: "mcp" }, "claude", installed), ["codex"]);
    assert.deepEqual(copyTargets({ kind: "command" }, "codex", () => true), ["claude", "grok", "opencode"]);
    assert.deepEqual(copyTargets({ kind: "plugin" }, "claude", () => true), [], "plugins do not copy");
    assert.deepEqual(copyTargets({ kind: "hook" }, "claude", () => true), []);
  });

  it("names where an inherited item is managed", () => {
    assert.equal(manageInAgent(item({ id: "s", source: { type: "inherited", label: "From Claude", ownerAgent: "claude" } })), "claude");
    assert.equal(manageInAgent(item({ id: "s", source: { type: "inherited", label: "Shared · ~/.agents" } })), null);
    assert.equal(manageInAgent(ITEMS[0]!), null);
  });
});

describe("the instructions card", () => {
  const NOW = Date.parse("2026-09-28T12:00:00.000Z");

  it("names the file, its lines and when it was edited", () => {
    assert.deepEqual(
      instructionsLine(
        { path: "/var/lib/orquester/.claude/CLAUDE.md", exists: true, bytes: 900, lines: 42, mtime: "2026-09-28T10:00:00.000Z", revision: "x", warnings: [] },
        NOW
      ),
      { fileName: "CLAUDE.md", detail: "42 lines · edited 2h ago" }
    );
    assert.equal(
      instructionsLine({ path: "C:\\h\\AGENTS.md", exists: true, bytes: 1, lines: 1, revision: "", warnings: [] }, NOW).detail,
      "1 line"
    );
  });

  it("says a missing file is not created yet", () => {
    assert.deepEqual(
      instructionsLine({ path: "/h/.grok/AGENTS.md", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] }, NOW),
      { fileName: "AGENTS.md", detail: "Not created yet — click to write it" }
    );
    assert.equal(fileNameOf(""), "");
    assert.equal(instructionsLine({ path: "", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] }, NOW).fileName, "Instructions");
  });
});

describe("agents and layout", () => {
  it("lists the four agents, installed as the snapshot, else the overview, says", () => {
    const options = agentProfileAgentOptions(
      [
        { agent: "claude", installed: true, version: "2.1", counts: {} },
        { agent: "grok", installed: true, counts: {} }
      ],
      { grok: snapshot({ agent: "grok", installed: false }) }
    );
    assert.deepEqual(
      options.map((option) => [option.id, option.label, option.installed]),
      [
        ["claude", "Claude", true],
        ["codex", "Codex", null],
        ["grok", "Grok", false],
        ["opencode", "OpenCode", null]
      ]
    );
    assert.equal(options[0]?.version, "2.1");
  });

  it("collapses the picker to a dropdown below the segmented control's width", () => {
    assert.equal(agentPickerLayout(null), "segmented", "unmeasured: a phone's section fits");
    assert.equal(agentPickerLayout(260), "dropdown", "the dock's minimum");
    assert.equal(agentPickerLayout(319), "dropdown", "the dock's default 320 px, inside its border");
    assert.equal(agentPickerLayout(330), "dropdown", "too narrow for the four names in a wide font");
    assert.equal(agentPickerLayout(AGENT_PICKER_SEGMENTED_MIN_WIDTH - 1), "dropdown");
    assert.equal(agentPickerLayout(AGENT_PICKER_SEGMENTED_MIN_WIDTH), "segmented");
    assert.equal(agentPickerLayout(352), "segmented", "a 360 px phone's section");
    assert.equal(agentPickerLayout(560), "segmented", "the dock's maximum");
  });
});
