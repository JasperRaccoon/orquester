import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentProfileSnapshot, ProfileItem } from "@orquester/api";

import {
  AGENT_PICKER_SEGMENTED_MIN_WIDTH,
  agentPickerLayout,
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  effectiveKindFilter,
  emptyKindTitle,
  fileNameOf,
  filterProfileItems,
  groupProfileItems,
  instructionsLine,
  isAgentNotInstalled,
  manageInAgent,
  matchesProfileQuery,
  profileKindChips,
  switchDisabledReason,
  switchLabel
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

describe("kind chips", () => {
  it("All then the agent's own kinds in AGENT_PROFILE_KINDS order, each counted — zero included", () => {
    assert.deepEqual(
      profileKindChips("claude", ITEMS).map((chip) => [chip.id, chip.label, chip.count]),
      [
        ["all", "All", 6],
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
      profileKindChips("opencode", []).map((chip) => chip.id),
      ["all", "mcp", "skill", "plugin", "command"]
    );
    assert.equal(effectiveKindFilter("opencode", "hook"), "all", "a filter the agent lacks falls back to All");
    assert.equal(effectiveKindFilter("opencode", "skill"), "skill");
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

  it("filters by kind and query together", () => {
    assert.deepEqual(
      filterProfileItems(ITEMS, { kind: "mcp", query: "" }).map((entry) => entry.id),
      ["mcp:jira", "mcp:Atlas"]
    );
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "all", query: "review" }).map((entry) => entry.id), ["skill:review"]);
    assert.deepEqual(filterProfileItems(ITEMS, { kind: "skill", query: "jira" }), []);
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
    kind: "all" as const,
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

  it("no matches, an empty kind, or nothing at all", () => {
    assert.deepEqual(agentProfileEmptyState({ ...base, shown: 0, query: " jira " }), { kind: "no-matches", query: "jira" });
    assert.deepEqual(agentProfileEmptyState({ ...base, shown: 0, kind: "mcp" }), { kind: "empty-kind", itemKind: "mcp" });
    assert.deepEqual(agentProfileEmptyState({ ...base, shown: 0 }), { kind: "none" });
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

describe("a row's switch and menu", () => {
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
    assert.equal(agentPickerLayout(null), "segmented", "unmeasured: the default dock width fits");
    assert.equal(agentPickerLayout(260), "dropdown", "the dock's minimum");
    assert.equal(agentPickerLayout(AGENT_PICKER_SEGMENTED_MIN_WIDTH - 1), "dropdown");
    assert.equal(agentPickerLayout(AGENT_PICKER_SEGMENTED_MIN_WIDTH), "segmented");
    assert.equal(agentPickerLayout(352), "segmented", "a 360 px phone's section");
    assert.equal(agentPickerLayout(560), "segmented", "the dock's maximum");
  });
});
