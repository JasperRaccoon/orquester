import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collapsedRosterLabel,
  expandedRosterLabel,
  partitionRosterRows,
  rosterKindCounts,
  shellSectionLabel
} from "./roster-summary";

const agent = (status: "running" | "completed" | "idle") => ({ agentKind: "agent" as const, status });
const shell = (status: "running" | "completed" | "failed") => ({ agentKind: "background" as const, status });

describe("rosterKindCounts", () => {
  it("counts agents and shells apart, live ones included", () => {
    const counts = rosterKindCounts([
      agent("running"),
      agent("running"),
      agent("completed"),
      agent("idle"),
      shell("running"),
      shell("completed")
    ]);
    assert.deepEqual(counts, { agents: 4, shells: 2, liveAgents: 2, liveShells: 1 });
  });
});

describe("collapsedRosterLabel", () => {
  it("names both kinds and says when the shells still run", () => {
    assert.equal(
      collapsedRosterLabel({ agents: 4, shells: 1, liveAgents: 4, liveShells: 1 }),
      "4 agents · 1 shell running"
    );
    assert.equal(
      collapsedRosterLabel({ agents: 1, shells: 2, liveAgents: 0, liveShells: 1 }),
      "1 agent · 2 shells (1 running)"
    );
    assert.equal(
      collapsedRosterLabel({ agents: 2, shells: 1, liveAgents: 0, liveShells: 0 }),
      "2 agents · 1 shell"
    );
  });

  it("omits the kind that is absent and never prints a zero", () => {
    assert.equal(collapsedRosterLabel({ agents: 3, shells: 0, liveAgents: 1, liveShells: 0 }), "3 agents");
    assert.equal(collapsedRosterLabel({ agents: 0, shells: 1, liveAgents: 0, liveShells: 1 }), "1 shell running");
    assert.equal(collapsedRosterLabel({ agents: 0, shells: 0, liveAgents: 0, liveShells: 0 }), "Agents");
  });
});

describe("expandedRosterLabel and shellSectionLabel", () => {
  it("call a shells-only roster what it is", () => {
    assert.equal(expandedRosterLabel({ agents: 0, shells: 2, liveAgents: 0, liveShells: 0 }), "Shells");
    assert.equal(expandedRosterLabel({ agents: 1, shells: 2, liveAgents: 0, liveShells: 0 }), "Agents");
    assert.deepEqual(shellSectionLabel({ agents: 1, shells: 1, liveAgents: 0, liveShells: 1 }), {
      title: "Shell",
      detail: "1 running"
    });
    assert.deepEqual(shellSectionLabel({ agents: 1, shells: 3, liveAgents: 0, liveShells: 0 }), {
      title: "Shells",
      detail: null
    });
  });
});

describe("partitionRosterRows", () => {
  it("keeps each kind's order while splitting them", () => {
    const rows = [
      { id: "a1", agent: { agentKind: "agent" as const } },
      { id: "s1", agent: { agentKind: "background" as const } },
      { id: "a2", agent: { agentKind: "agent" as const } },
      { id: "s2", agent: { agentKind: "background" as const } }
    ];
    const { agentRows, shellRows } = partitionRosterRows(rows);
    assert.deepEqual(agentRows.map((row) => row.id), ["a1", "a2"]);
    assert.deepEqual(shellRows.map((row) => row.id), ["s1", "s2"]);
  });
});
