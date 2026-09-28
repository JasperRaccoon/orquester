import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyWorkflowPatch, createWorkflowFromRequest, findWorkflowNode, WorkflowPatchError, type PatchEnvironment } from "./patch.ts";
import { sequentialIds, testEdge, testNode, testWorkflow } from "./testing.ts";
import type { Workflow, WorkflowPatchOp } from "./types.ts";
import { validateWorkflow } from "./validate.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function env(): PatchEnvironment {
  return { mintId: sequentialIds(), now: () => NOW };
}

function base(): Workflow {
  return testWorkflow(
    [
      testNode("t", "trigger.manual", {}, { name: "Manual", position: { x: 0, y: 0 } }),
      testNode("fetch", "code", {}, { name: "Fetch", position: { x: 320, y: 0 } }),
      testNode("fix", "agent", {
        prompt: { kind: "text", text: "Fix {{ nodes.Fetch.output.tickets | json }} ({{ nodes['Fetch'].status }})" }
      }, { name: "Fix", position: { x: 640, y: 0 } }),
      testNode("more", "agent", {
        prompt: { kind: "text", text: "Continue" },
        session: { kind: "continue", fromNode: "Fix" }
      }, { name: "More", position: { x: 960, y: 0 } }),
      testNode("post", "http", {
        url: "https://x.test/{{ nodes.Fetch.output.id }}",
        headers: [{ name: "X", value: "{{ nodes.Fix.output.text }}" }]
      }, { name: "Post", position: { x: 1280, y: 0 } })
    ],
    [testEdge("t", "fetch"), testEdge("fetch", "fix"), testEdge("fix", "more"), testEdge("more", "post")],
    { pinned: { fetch: { tickets: [] } } }
  );
}

function patch(ops: WorkflowPatchOp[], workflow = base()): Workflow {
  return applyWorkflowPatch(workflow, ops, env());
}

function patchError(ops: WorkflowPatchOp[], workflow = base()): WorkflowPatchError {
  try {
    applyWorkflowPatch(workflow, ops, env());
  } catch (error) {
    assert.ok(error instanceof WorkflowPatchError);
    return error;
  }
  assert.fail("expected a WorkflowPatchError");
}

describe("applyWorkflowPatch", () => {
  it("never mutates its input and stamps updatedAt", () => {
    const original = base();
    const snapshot = structuredClone(original);
    const result = applyWorkflowPatch(original, [{ op: "set_enabled", enabled: true }], env());
    assert.deepEqual(original, snapshot);
    assert.equal(result.enabled, true);
    assert.equal(result.updatedAt, NOW.toISOString());
    assert.equal(result.revision, original.revision, "the revision is the daemon's");
  });

  it("add_node mints unique ids and names, fills defaults and merges config", () => {
    const result = patch([
      { op: "add_node", node: { type: "agent" } },
      { op: "add_node", node: { type: "agent", config: { maxMinutes: 30 } } },
      { op: "connect", source: "Post", target: "Agent" }
    ]);
    const first = findWorkflowNode(result, "Agent")!;
    const second = findWorkflowNode(result, "Agent2")!;
    assert.equal(first.id, "id-1");
    assert.equal(second.id, "id-2");
    assert.equal(second.type === "agent" && second.config.maxMinutes, 30);
    assert.equal(second.type === "agent" && second.config.chain[0]!.agent, "claude");
    assert.equal(result.edges.at(-1)!.id, "id-3");
    assert.equal(result.edges.at(-1)!.sourceHandle, "success");
  });

  it("add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs", () => {
    const result = patch([{ op: "add_node", node: { id: "n1", type: "note", name: "Memo", position: { x: 5, y: 6 } } }]);
    assert.deepEqual(findWorkflowNode(result, "n1")!.position, { x: 5, y: 6 });
    assert.match(patchError([{ op: "add_node", node: { id: "t", type: "code" } }]).message, /id "t" already exists/);
    assert.match(patchError([{ op: "add_node", node: { type: "code", name: "Fetch" } }]).message, /already exists/);
    assert.match(patchError([{ op: "add_node", node: { type: "code", name: "bad name" } }]).message, /not a valid block name/);
    assert.match(patchError([{ op: "add_node", node: { type: "teleport" as "code" } }]).message, /Unknown block type/);
    assert.match(patchError([{ op: "add_node", node: { type: "agent", config: { chain: [] } } }]).message, /chain/);
  });

  it("update_node merges config one level deep; null clears", () => {
    const result = patch([
      { op: "update_node", node: "Post", set: { config: { method: "POST", body: { kind: "json", value: "{}" } }, notes: "hi", timeoutMinutes: 5 } }
    ]);
    const post = findWorkflowNode(result, "post")!;
    assert.equal(post.type === "http" && post.config.method, "POST");
    assert.equal(post.type === "http" && post.config.url, "https://x.test/{{ nodes.Fetch.output.id }}", "untouched keys stay");
    assert.equal(post.notes, "hi");
    const cleared = patch([{ op: "update_node", node: "post", set: { config: { body: null }, notes: null } }], result);
    const after = findWorkflowNode(cleared, "post")!;
    assert.equal(after.type === "http" && after.config.body, undefined);
    assert.equal(after.notes, undefined);
    assert.equal(after.timeoutMinutes, 5);
  });

  it("update_node refuses id/type changes, unknown fields and invalid configs", () => {
    assert.match(patchError([{ op: "update_node", node: "Post", set: { type: "code" } }]).message, /cannot change/);
    assert.match(patchError([{ op: "update_node", node: "Post", set: { colour: "red" } }]).message, /Unknown block field/);
    assert.match(patchError([{ op: "update_node", node: "Post", set: { config: { url: null } } }]).message, /url/);
    assert.match(patchError([{ op: "update_node", node: "Nope", set: {} }]).message, /no block "Nope"/);
  });

  it("update_node with a name renames and rewrites references, including its own", () => {
    const result = patch([
      { op: "update_node", node: "Fix", set: { name: "Repair", config: { prompt: { kind: "text", text: "{{ nodes.Fix.status }}" } } } }
    ]);
    const repair = findWorkflowNode(result, "Repair")!;
    assert.equal(repair.id, "fix");
    assert.equal(repair.type === "agent" && repair.config.prompt.kind === "text" && repair.config.prompt.text, "{{ nodes.Fix.status }}", "the set config is taken as given");
    const post = findWorkflowNode(result, "Post")!;
    assert.equal(post.type === "http" && post.config.headers[0]!.value, "{{ nodes.Repair.output.text }}");
  });

  it("rename_node rewrites every template reference and session.fromNode", () => {
    const result = patch([
      { op: "rename_node", node: "Fetch", to: "FetchTickets" },
      { op: "rename_node", node: "fix", to: "FixTickets" }
    ]);
    const fix = findWorkflowNode(result, "FixTickets")!;
    assert.equal(
      fix.type === "agent" && fix.config.prompt.kind === "text" && fix.config.prompt.text,
      "Fix {{ nodes.FetchTickets.output.tickets | json }} ({{ nodes['FetchTickets'].status }})"
    );
    const more = findWorkflowNode(result, "More")!;
    assert.equal(more.type === "agent" && more.config.session.kind === "continue" && more.config.session.fromNode, "FixTickets");
    const post = findWorkflowNode(result, "Post")!;
    assert.equal(post.type === "http" && post.config.url, "https://x.test/{{ nodes.FetchTickets.output.id }}");
    assert.equal(post.type === "http" && post.config.headers[0]!.value, "{{ nodes.FixTickets.output.text }}");
    assert.deepEqual(validateWorkflow(result).problems.filter((problem) => problem.severity === "error"), []);
    assert.equal(patch([{ op: "rename_node", node: "Fetch", to: "Fetch" }]).nodes.length, 5, "a no-op rename");
    assert.match(patchError([{ op: "rename_node", node: "Fetch", to: "Post" }]).message, /already exists/);
    assert.match(patchError([{ op: "rename_node", node: "Fetch", to: "1x" }]).message, /not a valid/);
  });

  it("remove_node drops its edges and pin", () => {
    const result = patch([{ op: "remove_node", node: "Fetch" }]);
    assert.equal(findWorkflowNode(result, "fetch"), undefined);
    assert.ok(result.edges.every((edge) => edge.source !== "fetch" && edge.target !== "fetch"));
    assert.equal(result.pinned, undefined);
  });

  it("connect checks handles, inputs, self-loops and duplicates", () => {
    const withIf = patch([{ op: "add_node", node: { id: "if", type: "if", name: "Check" } }]);
    const ok = patch([{ op: "connect", source: "Check", sourceHandle: "true", target: "Post" }], withIf);
    assert.equal(ok.edges.at(-1)!.sourceHandle, "true");
    assert.match(patchError([{ op: "connect", source: "Check", target: "Post" }], withIf).message, /no "success" output/);
    assert.match(patchError([{ op: "connect", source: "Fetch", target: "Manual" }]).message, /takes no input/);
    assert.match(patchError([{ op: "connect", source: "Fetch", target: "Fetch" }]).message, /itself/);
    assert.match(patchError([{ op: "connect", source: "Fetch", target: "Fix" }]).message, /already connected/);
    assert.match(patchError([{ op: "connect", source: "Fetch", sourceHandle: "error", target: "Ghost" }]).message, /no block "Ghost"/);
  });

  it("disconnect by id or by endpoints", () => {
    const byId = patch([{ op: "disconnect", edgeId: "t-success-fetch" }]);
    assert.equal(byId.edges.length, 3);
    const byEnds = patch([{ op: "disconnect", source: "Fix", target: "More" }]);
    assert.ok(!byEnds.edges.some((edge) => edge.source === "fix" && edge.target === "more"));
    assert.match(patchError([{ op: "disconnect", edgeId: "nope" }]).message, /no connection/);
    assert.match(patchError([{ op: "disconnect", source: "Fix", sourceHandle: "error", target: "More" }]).message, /not connected/);
  });

  it("settings, project, enabled, name, pins", () => {
    const result = patch([
      { op: "set_settings", settings: { overlap: "queue", notify: { onSuccess: true } as never } },
      { op: "set_project", project: { kind: "temp", workspace: "ws", source: { kind: "empty" } } },
      { op: "set_name", name: "  Renamed ", description: "About" },
      { op: "set_pinned", node: "Fix", output: { text: "done" } },
      { op: "set_pinned", node: "fetch", output: null }
    ]);
    assert.equal(result.settings.overlap, "queue");
    assert.deepEqual(result.settings.notify, { onFailure: true, onSuccess: true });
    assert.equal(result.project.kind, "temp");
    assert.equal(result.name, "Renamed");
    assert.equal(result.description, "About");
    assert.deepEqual(result.pinned, { fix: { text: "done" } });
    const cleared = patch([{ op: "set_name", name: "X", description: null }, { op: "set_pinned", node: "Fix", output: null }], result);
    assert.equal(cleared.description, undefined);
    assert.equal(cleared.pinned, undefined);
    assert.match(patchError([{ op: "set_settings", settings: { maxConcurrent: 99 } }]).message, /maxConcurrent/);
    assert.match(patchError([{ op: "set_project", project: { kind: "moon" } as never }]).message, /project/);
    assert.match(patchError([{ op: "set_name", name: "" }]).message, /1–120/);
    assert.match(patchError([{ op: "set_enabled", enabled: "yes" as never }]).message, /true or false/);
  });

  it("is atomic: the failing op is named and nothing applies", () => {
    const original = base();
    const error = patchError(
      [
        { op: "rename_node", node: "Fetch", to: "F2" },
        { op: "remove_node", node: "Post" },
        { op: "connect", source: "F2", target: "Nope" }
      ],
      original
    );
    assert.equal(error.opIndex, 2);
    assert.deepEqual(original, base());
    assert.equal(patchError([{ op: "explode" } as never]).opIndex, 0);
    assert.match(patchError([{ op: "explode" } as never]).message, /Unknown op/);
  });
});

describe("createWorkflowFromRequest", () => {
  it("mints ids and names, applies defaults and resolves edge refs by name", () => {
    const workflow = createWorkflowFromRequest(
      {
        name: "Nightly",
        project: { kind: "existing", projectPath: "/w/ws/app" },
        settings: { timezone: "Europe/Madrid" },
        nodes: [
          { type: "trigger.schedule", name: "Nightly", config: { preset: { kind: "daily", time: "02:00" }, cron: "0 2 * * *" } },
          { type: "agent", name: "Work", config: { prompt: { kind: "text", text: "Tidy {project}" } } },
          { type: "stop", config: { as: "failure" } },
          { type: "note", config: { text: "hello" } }
        ],
        edges: [
          { source: "Nightly", target: "Work" },
          { source: "Work", sourceHandle: "error", target: "Stop", id: "fail-edge" }
        ]
      },
      env()
    );
    assert.equal(workflow.id, "id-1");
    assert.equal(workflow.revision, 0);
    assert.equal(workflow.enabled, false);
    assert.equal(workflow.createdAt, NOW.toISOString());
    assert.equal(workflow.settings.overlap, "skip");
    assert.equal(workflow.settings.timezone, "Europe/Madrid");
    assert.deepEqual(workflow.nodes.map((node) => node.name), ["Nightly", "Work", "Stop", "Note"]);
    assert.equal(workflow.edges[1]!.id, "fail-edge");
    assert.equal(workflow.edges[0]!.source, workflow.nodes[0]!.id);
    assert.deepEqual(validateWorkflow(workflow).problems, []);
  });

  it("create preserves caller-provided positions", () => {
    const request = {
      name: "L",
      project: { kind: "existing" as const, projectPath: "/w/ws/app" },
      nodes: [
        { id: "a", type: "trigger.manual" as const, position: { x: 999, y: 999 } },
        { id: "b", type: "code" as const }
      ],
      edges: [{ source: "a", target: "b" }]
    };
    const kept = createWorkflowFromRequest(request, env());
    assert.deepEqual(findWorkflowNode(kept, "a")!.position, { x: 999, y: 999 });
  });

  it("names the failing node or edge", () => {
    const request = {
      name: "Bad",
      project: { kind: "existing" as const, projectPath: "/w/ws/app" },
      nodes: [{ type: "code" as const }, { type: "code" as const, name: "Code" }],
      edges: []
    };
    assert.equal(
      (() => {
        try {
          createWorkflowFromRequest(request, env());
        } catch (error) {
          return (error as WorkflowPatchError).opIndex;
        }
        return -1;
      })(),
      1
    );
    const badEdge = { ...request, nodes: [{ type: "code" as const }], edges: [{ source: "Code", target: "Nope" }] };
    assert.throws(() => createWorkflowFromRequest(badEdge, env()), (error: unknown) => error instanceof WorkflowPatchError && error.opIndex === 1);
    assert.throws(() => createWorkflowFromRequest({ ...request, name: " " }, env()), WorkflowPatchError);
    assert.throws(() => createWorkflowFromRequest({ ...request, nodes: [], project: { kind: "nope" } as never }, env()), WorkflowPatchError);
  });
});
