import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentProfileSnapshot, ProfileItem } from "@orquester/api";

import {
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  effectiveKindFilter,
  filterProfileItems,
  groupProfileItems,
  isAgentNotInstalled,
  manageInAgent,
  matchesProfileQuery,
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

describe("kind chips", () => {

  it("only the kinds that agent has: OpenCode has no marketplaces or hooks", () => {
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
      groups.map((group) => [group.kind, group.items.map((entry) => entry.name)]),
      [
        ["mcp", ["Atlas", "jira"]],
        ["skill", ["review"]],
        ["plugin", ["superpowers"]],
        ["hook", ["PreToolUse"]],
        ["command", ["pr"]]
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

  it("knows an agent is not installed from its snapshot, its refusal, or the overview", () => {
    assert.equal(isAgentNotInstalled({ snapshot: snapshot({ installed: false }), errorCode: null, overviewInstalled: true }), true);
    assert.equal(isAgentNotInstalled({ snapshot: snapshot(), errorCode: null, overviewInstalled: false }), false, "the snapshot is fresher");
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: "AGENT_NOT_INSTALLED", overviewInstalled: null }), true);
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: null, overviewInstalled: false }), true);
    assert.equal(isAgentNotInstalled({ snapshot: null, errorCode: null, overviewInstalled: null }), false);
  });
});

describe("a row's switch and menu", () => {
  it("its tooltip carries the adapter's off-switch caveat while on", () => {
    const offNote = "Turning it off also blocks a project MCP server named \"jira\".";
    assert.ok(switchTitle(item({ id: "mcp:jira", meta: { offNote } })).includes(offNote));
    assert.ok(!switchTitle(item({ id: "mcp:jira", enabled: false, meta: { offNote } })).includes(offNote));
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
      options.map((option) => [option.id, option.installed]),
      [
        ["claude", true],
        ["codex", null],
        ["grok", false],
        ["opencode", null]
      ]
    );
    assert.equal(options[0]?.version, "2.1");
  });

});
