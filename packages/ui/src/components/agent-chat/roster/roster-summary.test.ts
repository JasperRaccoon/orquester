import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  partitionRosterRows,
  rosterKindCounts
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
    assert.deepEqual(counts, { agents: 4, shells: 2, loops: 0, goals: 0, liveAgents: 2, liveShells: 1 });
  });

  it("counts a loop and a goal as neither an agent nor a shell", () => {
    const counts = rosterKindCounts([
      agent("running"),
      { kind: "loop" as const, agentKind: "background" as const, status: "running" as const },
      { kind: "goal" as const, agentKind: "background" as const, status: "completed" as const },
      shell("running")
    ]);
    assert.deepEqual(counts, { agents: 1, shells: 1, loops: 1, goals: 1, liveAgents: 1, liveShells: 1 });
  });
});

describe("partitionRosterRows", () => {

  it("renders a loop and a goal with the agents, never as shells", () => {
    const rows = [
      { id: "l1", agent: { kind: "loop" as const, agentKind: "background" as const } },
      { id: "s1", agent: { agentKind: "background" as const } },
      { id: "g1", agent: { kind: "goal" as const, agentKind: "background" as const } }
    ];
    const { agentRows, shellRows } = partitionRosterRows(rows);
    assert.deepEqual(agentRows.map((row) => row.id), ["l1", "g1"]);
    assert.deepEqual(shellRows.map((row) => row.id), ["s1"]);
  });
});
