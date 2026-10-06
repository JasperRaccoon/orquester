import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type {
  GetWorkflowResponse,
  PatchWorkflowRequest,
  ReplaceWorkflowRequest,
  Workflow,
  WorkflowWriteResponse
} from "@orquester/api";

import {
  WorkflowEditor,
  flushAllWorkflowEditors,
  workflowEditorFor,
  retainWorkflowEditor,
  type WorkflowEditorApi
} from "./editor-store.ts";
import type { ProviderSnapshot } from "@orquester/api/agent-chat";

import { editorAgentCatalog } from "./chain-models.ts";
import { edge, node, workflow } from "./testing.ts";
import { applyWorkflowsEvent, resetWorkflows, summaryFromRecord } from "./store.ts";

const editors = new Set<WorkflowEditor>();
const releases: (() => void)[] = [];
const timers = { advance: (ms: number) => mock.timers.tick(ms) };

beforeEach(() => {
  resetWorkflows();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  mock.timers.tick(1_000);
  for (const editor of editors) editor.dispose();
  editors.clear();
  await settle();
  mock.timers.reset();
});

function retain(editor: WorkflowEditor): WorkflowEditor {
  releases.push(retainWorkflowEditor(editor));
  return editor;
}

interface Deferred {
  release: () => void;
}

class FakeApi implements WorkflowEditorApi {
  server: Workflow;
  puts: ReplaceWorkflowRequest[] = [];
  patches: PatchWorkflowRequest[] = [];
  /** When set, the next PUT waits for `release()`. */
  hold = false;
  held: Deferred[] = [];
  constructor(initial: Workflow) {
    this.server = initial;
  }
  async getWorkflow(): Promise<GetWorkflowResponse> {
    return { workflow: structuredClone(this.server), problems: [] };
  }
  async replaceWorkflow(_id: string, req: ReplaceWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.puts.push(structuredClone(req));
    if (this.hold) {
      await new Promise<void>((resolve) => this.held.push({ release: resolve }));
    }
    if (req.revision !== this.server.revision) {
      throw Object.assign(new Error("Stale"), { status: 409, code: "REVISION_CONFLICT" });
    }
    this.server = {
      ...(req.workflow as Workflow),
      id: this.server.id,
      revision: this.server.revision + 1,
      createdAt: this.server.createdAt,
      updatedAt: this.server.updatedAt
    };
    return { workflow: structuredClone(this.server), problems: [] };
  }
  async patchWorkflow(_id: string, req: PatchWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.patches.push(structuredClone(req));
    if (req.revision !== this.server.revision) {
      throw Object.assign(new Error("Stale"), { status: 409, code: "REVISION_CONFLICT" });
    }
    const op = req.ops[0];
    this.server = { ...this.server, revision: this.server.revision + 1, ...(op?.op === "set_enabled" ? { enabled: op.enabled } : {}) };
    return { workflow: structuredClone(this.server), problems: [] };
  }
  /** Another client saves (an agent through the MCP). */
  saveElsewhere(mutate: (workflow: Workflow) => Workflow): void {
    this.server = { ...mutate(this.server), revision: this.server.revision + 1 };
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function setup(initial = workflow([node("t", "trigger.manual", {}, { name: "Start" }), node("a", "agent", {}, { name: "Review" })], [edge("t", "a")])) {
  const api = new FakeApi(initial);
  const remote = {
    announce(revision: number) {
      applyWorkflowsEvent({ type: "workflow.upserted", payload: { workflow: summaryFromRecord({ ...api.server, revision }) } });
    }
  };
  const editor = new WorkflowEditor(api, initial.id);
  editors.add(editor);
  await editor.load();
  return { api, timers, remote, editor };
}

const rename = (name: string) => (draft: Workflow): Workflow => ({ ...draft, name });

describe("editor-store: loading", () => {
  it("a missing workflow is an error with words, not a crash", async () => {
    const api = new FakeApi(workflow([]));
    api.getWorkflow = async () => {
      throw Object.assign(new Error("gone"), { status: 404, code: "WORKFLOW_NOT_FOUND" });
    };
    const editor = new WorkflowEditor(api, "wf-1");
    editors.add(editor);
    await editor.load();
    assert.equal(editor.state.status, "error");
    assert.equal(editor.state.draft, null);
    assert.ok(editor.state.loadError);
  });
});

describe("editor-store: autosave", () => {
  it("saves 600 ms after the last change, once, with the revision the draft is based on", async () => {
    const { api, timers, editor } = await setup();
    editor.change(rename("One"));
    timers.advance(500);
    editor.change(rename("Two"));
    timers.advance(599);
    assert.equal(api.puts.length, 0, "nothing before the quiet period ends");
    assert.equal(editor.state.saveState, "pending");
    timers.advance(1);
    await settle();
    assert.equal(api.puts.length, 1);
    assert.equal(api.puts[0]!.revision, 1);
    assert.equal(api.puts[0]!.workflow.name, "Two");
    assert.equal(editor.state.revision, 2);
    assert.equal(editor.state.dirty, false);
    assert.equal(editor.state.saveState, "saved");
  });

  it("the body leaves out the daemon's own fields", async () => {
    const { api, timers, editor } = await setup();
    editor.change(rename("X"));
    timers.advance(600);
    await settle();
    const body = api.puts[0]!.workflow as Record<string, unknown>;
    for (const key of ["id", "revision", "createdAt", "updatedAt"]) assert.equal(key in body, false, key);
  });

  it("serializes saves: a change during a save is saved right after it, on the new revision", async () => {
    const { api, timers, editor } = await setup();
    api.hold = true;
    editor.change(rename("First"));
    timers.advance(600);
    await settle();
    assert.equal(api.puts.length, 1);
    editor.change(rename("Second"));
    timers.advance(600);
    await settle();
    assert.equal(api.puts.length, 1, "no second PUT while the first is in flight");
    api.hold = false;
    api.held.shift()!.release();
    await settle();
    assert.equal(api.puts.length, 2);
    assert.equal(api.puts[1]!.revision, 2);
    assert.equal(api.puts[1]!.workflow.name, "Second");
    assert.equal(editor.state.revision, 3);
    assert.equal(editor.state.dirty, false);
  });

  it("a failed save says so and keeps the edit; flush retries it", async () => {
    const { api, timers, editor } = await setup();
    const real = api.replaceWorkflow.bind(api);
    let fail = true;
    api.replaceWorkflow = async (id, req) => {
      if (fail) throw Object.assign(new Error("Network down"), { status: 0 });
      return real(id, req);
    };
    editor.change(rename("Kept"));
    timers.advance(600);
    await settle();
    assert.equal(editor.state.saveState, "error");
    assert.equal(editor.state.saveError, "Network down");
    assert.equal(editor.state.draft?.name, "Kept");
    fail = false;
    await editor.flush();
    assert.equal(editor.state.saveState, "saved");
    assert.equal(api.server.name, "Kept");
  });

  it("an enabled draft the daemon refuses as invalid is saved disabled, and the editor says so", async () => {
    const { api, timers, editor } = await setup(workflow([node("t", "trigger.manual")], [], { enabled: true }));
    const real = api.replaceWorkflow.bind(api);
    api.replaceWorkflow = async (id, req) => {
      if (req.workflow.enabled) throw Object.assign(new Error("Invalid"), { status: 400, code: "INVALID_WORKFLOW" });
      return real(id, req);
    };
    editor.change(rename("Broken"));
    timers.advance(600);
    await settle();
    assert.equal(api.server.enabled, false);
    assert.equal(api.server.name, "Broken");
    assert.equal(editor.state.draft?.enabled, false);
    assert.ok(editor.state.notice);
  });
});

describe("editor-store: conflicts", () => {
  it("a 409 raises the banner and stops autosaving", async () => {
    const { api, timers, editor } = await setup();
    api.saveElsewhere(rename("Theirs"));
    editor.change(rename("Mine"));
    timers.advance(600);
    await settle();
    assert.deepEqual(editor.state.conflict, { kind: "save" });
    assert.equal(editor.state.saveState, "conflict");
    editor.change(rename("Mine again"));
    timers.advance(1_800);
    await settle();
    assert.equal(api.puts.length, 1, "no autosave while in conflict");
  });

  it("Reload takes their copy and drops the edits (and the undo history)", async () => {
    const { api, timers, editor } = await setup();
    api.saveElsewhere(rename("Theirs"));
    editor.change(rename("Mine"));
    timers.advance(600);
    await settle();
    await editor.reload();
    assert.equal(editor.state.conflict, null);
    assert.equal(editor.state.draft?.name, "Theirs");
    assert.equal(editor.state.revision, 2);
    assert.equal(editor.state.dirty, false);
    assert.equal(editor.state.canUndo, false);
  });

  it("Keep mine overwrites theirs with the draft", async () => {
    const { api, timers, editor } = await setup();
    api.saveElsewhere(rename("Theirs"));
    editor.change(rename("Mine"));
    timers.advance(600);
    await settle();
    await editor.keepMine();
    await settle();
    assert.equal(editor.state.conflict, null);
    assert.equal(api.server.name, "Mine");
    assert.equal(editor.state.saveState, "saved");
    assert.equal(editor.state.revision, 3);
  });
});

describe("editor-store: remote changes", () => {
  it("a newer revision while clean reloads silently", async () => {
    const { api, remote, editor } = await setup();
    api.saveElsewhere(rename("From the MCP"));
    remote.announce(2);
    await settle();
    assert.equal(editor.state.draft?.name, "From the MCP");
    assert.equal(editor.state.conflict, null);
  });

  it("a newer revision over unsaved edits raises the banner", async () => {
    const { api, remote, editor } = await setup();
    editor.change(rename("Mine"));
    api.saveElsewhere(rename("Theirs"));
    remote.announce(2);
    await settle();
    assert.deepEqual(editor.state.conflict, { kind: "remote" });
    assert.equal(editor.state.draft?.name, "Mine", "the draft is kept for Keep mine");
  });

  it("an own-save event before its response preserves the draft without a false conflict", async () => {
    const { api, timers, remote, editor } = await setup();
    api.hold = true;
    editor.change(rename("Mine"));
    timers.advance(600);
    await settle();
    // The event can land before the save's answer.
    remote.announce(2);
    api.held.shift()!.release();
    await settle();
    remote.announce(2);
    await settle();
    assert.equal(editor.state.conflict, null);
    assert.equal(editor.state.draft?.name, "Mine");
  });
});

describe("editor-store: history, enabling, validation", () => {
  it("undo drops a selection of blocks the older draft does not have", async () => {
    const { editor } = await setup();
    editor.change((draft) => ({ ...draft, nodes: [...draft.nodes, node("x", "code", {}, { name: "New" })] }), {
      select: { nodeIds: ["x"], edgeIds: [] }
    });
    editor.undo();
    assert.deepEqual(editor.state.selection.nodeIds, []);
  });

  it("enabling saves pending edits first, then patches set_enabled on the new revision", async () => {
    const { api, editor } = await setup();
    editor.change(rename("Ready"));
    assert.equal(await editor.setEnabled(true), null);
    assert.equal(api.puts.length, 1);
    assert.deepEqual(api.patches[0], { revision: 2, ops: [{ op: "set_enabled", enabled: true }] });
    assert.equal(editor.state.draft?.enabled, true);
    assert.equal(editor.state.revision, 3);
  });

  it("validates the draft a moment after each change", async () => {
    const { timers, editor } = await setup();
    editor.change((draft) => ({
      ...draft,
      nodes: draft.nodes.map((candidate) =>
        candidate.type === "agent" ? { ...candidate, config: { ...candidate.config, prompt: { kind: "text", text: "{{ nodes.Nope.output }}" } } } : candidate
      )
    }));
    timers.advance(600);
    assert.ok(editor.state.problems.some((problem) => problem.code === "unknown_reference" && problem.nodeId === "a"));
  });
});

/** A provider row as the client holds it — only what the catalogue reads is meaningful. */
function providerSnapshot(id: string, status: ProviderSnapshot["status"], slugs: string[]): ProviderSnapshot {
  return {
    id,
    refIds: [id],
    installed: true,
    version: null,
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-09-29T00:00:00.000Z",
    models: slugs.map((slug) => ({ slug, name: slug, capabilities: null })),
    slashCommands: [],
    skills: []
  } as unknown as ProviderSnapshot;
}

describe("editor-store: the agent catalogue", () => {
  const opusChain = [{ agent: "claude", model: "opus", accounts: { strategy: "least-used" } }];
  const nightly = () =>
    workflow(
      [node("t", "trigger.manual", {}, { name: "Start" }), node("a", "agent", { prompt: { kind: "text", text: "Tidy" }, chain: opusChain }, { name: "NightlyTask" })],
      [edge("t", "a")]
    );

  it("marks a model the live catalogue does not list, as the daemon does — and follows the catalogue", async () => {
    const { timers, editor } = await setup(nightly());
    editor.validateNow();
    assert.equal(editor.state.problems.filter((problem) => problem.code === "unknown_model").length, 0, "no catalogue, no check");

    const live = editorAgentCatalog(
      [{ id: "claude", enabled: true, chat: { adapter: "claude" } }],
      [providerSnapshot("claude", "ready", ["default", "opus[1m]", "sonnet"])]
    );
    assert.ok(live);
    editor.setValidationContext({ catalog: live });
    timers.advance(600);
    const models = editor.state.problems.filter((problem) => problem.code === "unknown_model");
    assert.deepEqual(models.map((problem) => [problem.severity, problem.nodeId, problem.field]), [["error", "a", "config.chain.0.model"]]);

    // The provider is re-probed and lists it: the error goes.
    editor.setValidationContext({
      catalog: editorAgentCatalog([{ id: "claude", enabled: true, chat: { adapter: "claude" } }], [providerSnapshot("claude", "ready", ["default", "opus"])])!
    });
    timers.advance(600);
    assert.equal(editor.state.problems.filter((problem) => problem.code === "unknown_model").length, 0);
  });

  it("a catalogue not loaded yet raises no false errors", async () => {
    const { timers, editor } = await setup(nightly());
    // No registry read yet: no catalogue at all.
    assert.equal(editorAgentCatalog([], []), undefined);
    // The registry, but the provider still being probed (or not listed yet): a warning only.
    for (const providers of [[], [providerSnapshot("claude", "unknown", ["default", "sonnet"])]]) {
      editor.setValidationContext({ catalog: editorAgentCatalog([{ id: "claude", enabled: true, chat: { adapter: "claude" } }], providers)! });
      timers.advance(600);
      const models = editor.state.problems.filter((problem) => problem.code === "unknown_model");
      assert.deepEqual(models.map((problem) => problem.severity), ["warning"]);
      assert.equal(editor.state.problems.some((problem) => problem.severity === "error"), false);
    }
  });
});

describe("editor-store: review fixes", () => {
  it("a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id)", async () => {
    const first = Object.assign(new FakeApi(workflow([node("t", "trigger.manual")])), { connection: { id: "c1" } });
    const editor = retain(workflowEditorFor(first, "wf-1"));
    await settle();
    editor.change(rename("Typing"));
    const second = Object.assign(new FakeApi(first.server), { connection: { id: "c1" } });
    const again = workflowEditorFor(second, "wf-1");
    assert.equal(again.state.draft?.name, "Typing");
    timers.advance(600);
    await settle();
    assert.equal(first.puts.length, 0, "the old client is not used any more");
    assert.equal(second.puts.length, 1);
    const other = Object.assign(new FakeApi(first.server), { connection: { id: "c2" } });
    const isolated = retain(workflowEditorFor(other, "wf-1"));
    await settle();
    assert.equal(isolated.state.draft?.name, "Test", "another connection has its own draft");
  });

  it("a load that lands after the user typed keeps the edit and raises the banner", async () => {
    const { api, remote, editor } = await setup();
    let release!: () => void;
    const realGet = api.getWorkflow.bind(api);
    api.getWorkflow = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return realGet();
    };
    api.saveElsewhere(rename("Theirs"));
    remote.announce(2); // clean → reload starts
    await settle();
    editor.change(rename("Mine")); // typed while the copy is on its way
    release();
    await settle();
    assert.equal(editor.state.draft?.name, "Mine");
    assert.deepEqual(editor.state.conflict, { kind: "remote" });
  });

  it("an Enable event before its response preserves enabled state without a false conflict", async () => {
    const { api, remote, editor } = await setup();
    const realPatch = api.patchWorkflow.bind(api);
    api.patchWorkflow = async (id, req) => {
      const answer = await realPatch(id, req);
      remote.announce(api.server.revision); // the echo lands before the answer
      return answer;
    };
    assert.equal(await editor.setEnabled(true), null);
    await settle();
    assert.equal(editor.state.revision, 2);
    assert.equal(editor.state.draft?.enabled, true);
    assert.equal(editor.state.conflict, null);
  });

  it("undo never flips enabled", async () => {
    const { editor } = await setup();
    editor.change(rename("A"));
    await editor.setEnabled(true);
    editor.undo();
    assert.equal(editor.state.draft?.name, "Test");
    assert.equal(editor.state.draft?.enabled, true);
  });

  it("reconnect: a failed save is retried; a newer daemon revision is a conflict", async () => {
    const { api, timers, editor } = await setup();
    const real = api.replaceWorkflow.bind(api);
    let fail = true;
    api.replaceWorkflow = async (id, req) => {
      if (fail) throw Object.assign(new Error("Network down"), { status: 0 });
      return real(id, req);
    };
    editor.change(rename("Kept"));
    timers.advance(600);
    await settle();
    assert.equal(editor.state.saveState, "error");
    fail = false;
    await editor.onReconnect();
    await settle();
    assert.equal(editor.state.saveState, "saved");
    assert.equal(api.server.name, "Kept");

    editor.change(rename("Again"));
    api.saveElsewhere(rename("Theirs"));
    await editor.onReconnect();
    assert.deepEqual(editor.state.conflict, { kind: "remote" });
    assert.equal(editor.state.draft?.name, "Again");
  });

  it("flushAllWorkflowEditors saves a pending edit at once (pagehide)", async () => {
    const api = Object.assign(new FakeApi(workflow([node("t", "trigger.manual")])), { connection: { id: "c9" } });
    const editor = retain(workflowEditorFor(api, "wf-9"));
    await settle();
    editor.change(rename("Leaving"));
    flushAllWorkflowEditors();
    await settle();
    assert.equal(api.server.name, "Leaving");
  });
});
