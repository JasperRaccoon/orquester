import { test } from "node:test";
import assert from "node:assert/strict";
import { agentConfigSchema, parseWorkflowsFile } from "./workflows.ts";

const STAMP = "2026-10-18T00:00:00.000Z";

function agentNode(config: Record<string, unknown>): Record<string, unknown> {
  return { id: "n1", type: "agent", name: "Fix", position: { x: 0, y: 0 }, config };
}

function record(nodes: unknown[]): Record<string, unknown> {
  return { id: "wf_1", name: "Nightly", project: { kind: "existing", projectPath: "/w/acme/api" }, nodes, createdAt: STAMP, updatedAt: STAMP };
}

const BASE = { prompt: { kind: "text", text: "Fix it" }, chain: [{ agent: "claude", model: "default" }] };

test("agent block profileId (Agent Profiles §5.5): kept by id, absent = Global, unknown fields survive", () => {
  const withProfile = agentConfigSchema.parse({ ...BASE, profileId: "prof-1", futureField: { a: 1 } });
  assert.equal(withProfile.profileId, "prof-1");
  assert.deepEqual((withProfile as Record<string, unknown>).futureField, { a: 1 });
  const global = agentConfigSchema.parse(BASE);
  assert.equal("profileId" in global, false, "no profile is written for a Global block");
});

test("agent block profileId: a blank or non-string id fails the block, so the record is set aside verbatim — never run as Global", () => {
  assert.equal(agentConfigSchema.safeParse({ ...BASE, profileId: "" }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...BASE, profileId: 7 }).success, false);
  const bad = record([agentNode({ ...BASE, profileId: "" })]);
  const good = { ...record([agentNode({ ...BASE, profileId: "prof-1" })]), id: "wf_2" };
  const file = parseWorkflowsFile({ version: 1, workflows: [bad, good] });
  assert.deepEqual(file.rejected, [bad]);
  assert.equal(file.workflows.length, 1);
  const node = file.workflows[0]!.nodes[0]!;
  assert.equal(node.type === "agent" ? node.config.profileId : null, "prof-1");
});
