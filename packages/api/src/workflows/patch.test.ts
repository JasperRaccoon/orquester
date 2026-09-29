import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyWorkflowPatch, createWorkflowFromRequest, findWorkflowNode, WorkflowPatchError, type PatchEnvironment } from "./patch.ts";
import { sequentialIds, testEdge, testNode, testWorkflow } from "./testing.ts";
import type { Workflow, WorkflowPatchOp } from "./types.ts";

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
    assert.notEqual(first.id, second.id);
    assert.ok(!base().nodes.some((node) => node.id === first.id || node.id === second.id));
    assert.equal(second.type === "agent" && second.config.maxMinutes, 30);
    assert.equal(second.type === "agent" && second.config.chain[0]!.agent, "claude");
    assert.equal(new Set(result.edges.map((edge) => edge.id)).size, result.edges.length);
    assert.equal(result.edges.at(-1)!.target, first.id);
    assert.equal(result.edges.at(-1)!.sourceHandle, "success");
  });

  it("add_node keeps caller identity and position and rejects invalid node data", () => {
    const result = patch([{ op: "add_node", node: { id: "n1", type: "note", name: "Memo", position: { x: 5, y: 6 } } }]);
    assert.equal(findWorkflowNode(result, "n1")!.name, "Memo");
    assert.deepEqual(findWorkflowNode(result, "n1")!.position, { x: 5, y: 6 });
    assert.equal(patchError([{ op: "add_node", node: { id: "t", type: "code" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "add_node", node: { type: "code", name: "Fetch" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "add_node", node: { type: "code", name: "bad name" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "add_node", node: { type: "teleport" as "code" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "add_node", node: { type: "agent", config: { chain: [] } } }]).opIndex, 0);
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
    assert.equal(patchError([{ op: "update_node", node: "Post", set: { type: "code" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "update_node", node: "Post", set: { colour: "red" } }]).opIndex, 0);
    assert.equal(patchError([{ op: "update_node", node: "Post", set: { config: { url: null } } }]).opIndex, 0);
    assert.equal(patchError([{ op: "update_node", node: "Nope", set: {} }]).opIndex, 0);
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
    assert.equal(patchError([{ op: "rename_node", node: "Fetch", to: "Post" }]).opIndex, 0);
    assert.equal(patchError([{ op: "rename_node", node: "Fetch", to: "1x" }]).opIndex, 0);
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
    assert.equal(patchError([{ op: "connect", source: "Check", target: "Post" }], withIf).opIndex, 0);
    assert.equal(patchError([{ op: "connect", source: "Fetch", target: "Manual" }]).opIndex, 0);
    assert.equal(patchError([{ op: "connect", source: "Fetch", target: "Fetch" }]).opIndex, 0);
    assert.equal(patchError([{ op: "connect", source: "Fetch", target: "Fix" }]).opIndex, 0);
    assert.equal(patchError([{ op: "connect", source: "Fetch", sourceHandle: "error", target: "Ghost" }]).opIndex, 0);
  });

  it("disconnect by id or by endpoints", () => {
    const byId = patch([{ op: "disconnect", edgeId: "t-success-fetch" }]);
    assert.ok(!byId.edges.some((edge) => edge.id === "t-success-fetch"));
    const byEnds = patch([{ op: "disconnect", source: "Fix", target: "More" }]);
    assert.ok(!byEnds.edges.some((edge) => edge.source === "fix" && edge.target === "more"));
    assert.equal(patchError([{ op: "disconnect", edgeId: "nope" }]).opIndex, 0);
    assert.equal(patchError([{ op: "disconnect", source: "Fix", sourceHandle: "error", target: "More" }]).opIndex, 0);
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
    assert.equal(patchError([{ op: "set_settings", settings: { maxConcurrent: 99 } }]).opIndex, 0);
    assert.equal(patchError([{ op: "set_project", project: { kind: "moon" } as never }]).opIndex, 0);
    assert.equal(patchError([{ op: "set_name", name: "" }]).opIndex, 0);
    assert.equal(patchError([{ op: "set_enabled", enabled: "yes" as never }]).opIndex, 0);
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
          { type: "trigger.schedule", name: "Nightly", position: { x: 999, y: 999 }, config: { preset: { kind: "daily", time: "02:00" }, cron: "0 2 * * *" } },
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
    assert.ok(workflow.id);
    assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, 4);
    assert.deepEqual(workflow.nodes[0]!.position, { x: 999, y: 999 });
    assert.equal(workflow.revision, 0);
    assert.equal(workflow.enabled, false);
    assert.equal(workflow.createdAt, NOW.toISOString());
    assert.equal(workflow.settings.overlap, "skip");
    assert.equal(workflow.settings.timezone, "Europe/Madrid");
    assert.deepEqual(workflow.nodes.map((node) => node.name), ["Nightly", "Work", "Stop", "Note"]);
    assert.equal(workflow.edges[1]!.id, "fail-edge");
    assert.equal(workflow.edges[0]!.source, workflow.nodes[0]!.id);
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
