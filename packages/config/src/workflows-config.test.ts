import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentConfigSchema,
  gateConfigSchema,
  parseWorkflowsFile,
  triggerManualConfigSchema,
  WORKFLOW_HANDLE_PATTERN,
  workflowEdgeSchema,
  workflowInputDeclSchema,
  workflowNodeSchema
} from "./workflows.ts";

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

// ---------------------------------------------------------------------------
// Typed inputs, outcomes, gates and loops (spec 2026-11-10)
// ---------------------------------------------------------------------------

test("manual trigger inputs (§4.1): typed declarations parse in order; absent = untyped, as before", () => {
  const config = triggerManualConfigSchema.parse({
    inputExample: '{"env":"stg"}',
    inputs: [
      { name: "env", type: "enum", values: ["stg", "prd"], required: true, default: "stg", description: "Target" },
      { name: "notes", type: "string", multiline: true },
      { name: "count", type: "number", default: 3 },
      { name: "dry_run", type: "boolean", default: false, futureField: 1 }
    ]
  });
  assert.deepEqual(config.inputs?.map((input) => input.name), ["env", "notes", "count", "dry_run"]);
  assert.equal(config.inputs?.[1]?.required, undefined, "absent required reads as absent (= false)");
  assert.equal((config.inputs?.[3] as Record<string, unknown>).futureField, 1);
  assert.equal("inputs" in triggerManualConfigSchema.parse({ inputExample: "{}" }), false);
});

test("manual trigger inputs: a bad name or type fails the shape", () => {
  assert.equal(workflowInputDeclSchema.safeParse({ name: "1env", type: "string" }).success, false);
  assert.equal(workflowInputDeclSchema.safeParse({ name: "env", type: "date" }).success, false);
  assert.equal(workflowInputDeclSchema.safeParse({ name: "env", type: "string", default: { a: 1 } }).success, false);
});

test("agent outcomes and outputs (§5.1): parse, keep unknown fields, absent on old blocks", () => {
  const config = agentConfigSchema.parse({
    ...BASE,
    outcomes: [{ id: "approved", label: "Approved", description: "Ready to merge" }, { id: "changes_requested", x: 1 }],
    outputs: [{ name: "pr_url", type: "string" }, { name: "risk", type: "enum", values: ["low", "high"], required: false }, { name: "data", type: "json" }]
  });
  assert.deepEqual(config.outcomes?.map((outcome) => outcome.id), ["approved", "changes_requested"]);
  assert.equal((config.outcomes?.[1] as Record<string, unknown>).x, 1);
  assert.equal(config.outputs?.[0]?.required, undefined, "absent required reads as absent (= true for outputs)");
  const old = agentConfigSchema.parse(BASE);
  assert.equal("outcomes" in old, false);
  assert.equal("outputs" in old, false);
  assert.equal(agentConfigSchema.safeParse({ ...BASE, outcomes: [{ id: "Approved" }] }).success, false, "outcome ids are lowercase");
  assert.equal(agentConfigSchema.safeParse({ ...BASE, outputs: [{ name: "x", type: "date" }] }).success, false);
});

test("gate config (§6.1): defaults decider human, comment none, agent-phase maxMinutes 60", () => {
  const gate = gateConfigSchema.parse({ question: "Ship?", choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject", color: "danger", comment: "optional" }] });
  assert.deepEqual(gate.decider, { kind: "human" });
  assert.equal(gate.choices[0]!.comment, "none");
  assert.equal(gate.choices[1]!.color, "danger");
  const launcher = gateConfigSchema.parse({ question: "q", choices: [], decider: { kind: "launcher" } });
  assert.equal(launcher.decider.kind === "launcher" ? launcher.decider.maxMinutes : null, 60);
  const agent = gateConfigSchema.parse({
    question: "q",
    choices: [],
    decider: { kind: "agent", prompt: { kind: "text", text: "Review it" }, chain: [{ agent: "claude", model: "default" }], profileId: "p1" },
    timeout: { minutes: 120, then: { kind: "choice", choice: "reject" } },
    later: true
  });
  assert.equal(agent.decider.kind === "agent" ? agent.decider.maxMinutes : null, 60);
  assert.deepEqual(agent.timeout, { minutes: 120, then: { kind: "choice", choice: "reject" } });
  assert.equal((agent as Record<string, unknown>).later, true);
  assert.equal(gateConfigSchema.safeParse({ question: "q", choices: [], decider: { kind: "robot" } }).success, false);
  assert.equal(gateConfigSchema.safeParse({ question: "q", choices: [{ id: "ok", label: "OK", color: "pink" }] }).success, false);
  assert.equal(gateConfigSchema.safeParse({ question: "q", choices: [], timeout: { minutes: 5, then: { kind: "retry" } } }).success, false);
  const node = workflowNodeSchema.parse({ id: "g", type: "gate", name: "Approve", position: { x: 0, y: 0 }, config: { question: "q", choices: [] } });
  assert.equal(node.type, "gate");
});

test("handle pattern (§5.1): widened to outcome:<id> and choice:<id>, old handles unchanged", () => {
  for (const handle of ["success", "error", "true", "false", "default", "case:0", "case:12", "outcome:approved", "choice:reject", "outcome:a_1"]) {
    assert.equal(WORKFLOW_HANDLE_PATTERN.test(handle), true, handle);
  }
  for (const handle of ["outcome:", "outcome:Approved", "choice:1a", "choice:a-b", "outcomes:x", "case:01", `outcome:a${"b".repeat(40)}`]) {
    assert.equal(WORKFLOW_HANDLE_PATTERN.test(handle), false, handle);
  }
});

test("loop edges (§7.1): maxLoops 1–20, session defaults to continue, unknown fields kept", () => {
  const edge = workflowEdgeSchema.parse({ id: "e", source: "a", sourceHandle: "outcome:changes", target: "b", loop: { maxLoops: 3, extra: 1 } });
  assert.deepEqual(edge.loop && { maxLoops: edge.loop.maxLoops, session: edge.loop.session }, { maxLoops: 3, session: "continue" });
  assert.equal((edge.loop as Record<string, unknown>).extra, 1);
  assert.equal(workflowEdgeSchema.parse({ id: "e", source: "a", sourceHandle: "success", target: "b" }).loop, undefined);
  for (const loop of [{ maxLoops: 0 }, { maxLoops: 21 }, { maxLoops: 1.5 }, { maxLoops: 2, session: "fork" }]) {
    assert.equal(workflowEdgeSchema.safeParse({ id: "e", source: "a", sourceHandle: "success", target: "b", loop }).success, false, JSON.stringify(loop));
  }
});

test("a workflows file mixing old and new records: both load, and a broken new field sets only its record aside", () => {
  const old = record([agentNode(BASE)]);
  const fresh = {
    ...record([
      { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: { inputs: [{ name: "env", type: "string" }] } },
      agentNode({ ...BASE, outcomes: [{ id: "approved" }, { id: "changes" }] }),
      { id: "g", type: "gate", name: "Ship", position: { x: 0, y: 0 }, config: { question: "Ship?", choices: [{ id: "go", label: "Go" }] } }
    ]),
    id: "wf_2",
    edges: [
      { id: "e1", source: "t", sourceHandle: "success", target: "n1" },
      { id: "e2", source: "n1", sourceHandle: "outcome:changes", target: "n1", loop: { maxLoops: 2 } },
      { id: "e3", source: "n1", sourceHandle: "outcome:approved", target: "g" }
    ],
    newerTopLevel: { kept: true }
  };
  const broken = { ...record([]), id: "wf_3", edges: [{ id: "e", source: "a", sourceHandle: "outcome:Bad", target: "b" }] };
  const file = parseWorkflowsFile({ version: 1, workflows: [old, fresh, broken] });
  assert.deepEqual(file.workflows.map((workflow) => workflow.id), ["wf_1", "wf_2"]);
  assert.deepEqual(file.rejected, [broken]);
  const loaded = file.workflows[1]!;
  assert.equal((loaded as Record<string, unknown>).newerTopLevel !== undefined, true);
  assert.equal(loaded.edges[1]!.loop?.session, "continue");
  assert.equal(loaded.nodes[2]!.type, "gate");
});
