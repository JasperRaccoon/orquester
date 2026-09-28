import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  GetWorkflowResponse,
  PatchWorkflowRequest,
  ReplaceWorkflowRequest,
  Workflow,
  WorkflowWriteResponse
} from "@orquester/api";

import {
  AUTOSAVE_DELAY_MS,
  VALIDATE_DELAY_MS,
  WorkflowEditor,
  flushAllWorkflowEditors,
  resetWorkflowEditors,
  workflowEditorFor,
  type EditorTimers,
  type RemoteRevisions,
  type WorkflowEditorApi
} from "./editor-store.ts";
import { edge, node, sequentialIds, workflow } from "./testing.ts";

class FakeTimers implements EditorTimers {
  time = 1_000_000;
  private seq = 0;
  private queue: { id: number; at: number; fn: () => void }[] = [];
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ id, at: this.time + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  }
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.queue.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((entry) => entry !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = until;
  }
}

class FakeRemote implements RemoteRevisions {
  revision: number | undefined = undefined;
  private listeners = new Set<() => void>();
  revisionOf(): number | undefined {
    return this.revision;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  announce(revision: number): void {
    this.revision = revision;
    for (const listener of [...this.listeners]) listener();
  }
}

interface Deferred {
  release: () => void;
}

class FakeApi implements WorkflowEditorApi {
  server: Workflow;
  puts: ReplaceWorkflowRequest[] = [];
  patches: PatchWorkflowRequest[] = [];
  gets = 0;
  /** When set, the next PUT waits for `release()`. */
  hold = false;
  held: Deferred[] = [];
  constructor(initial: Workflow) {
    this.server = initial;
  }
  async getWorkflow(): Promise<GetWorkflowResponse> {
    this.gets += 1;
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
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function setup(initial = workflow([node("t", "trigger.manual", {}, { name: "Start" }), node("a", "agent", {}, { name: "Review" })], [edge("t", "a")])) {
  const api = new FakeApi(initial);
  const timers = new FakeTimers();
  const remote = new FakeRemote();
  const editor = new WorkflowEditor(api, initial.id, { timers, remote, mintId: sequentialIds("n") });
  await editor.load();
  return { api, timers, remote, editor };
}

const rename = (name: string) => (draft: Workflow): Workflow => ({ ...draft, name });

describe("editor-store: loading", () => {
  it("loads the definition as the draft, clean, at its revision", async () => {
    const { editor } = await setup();
    assert.equal(editor.state.status, "ready");
    assert.equal(editor.state.revision, 1);
    assert.equal(editor.state.dirty, false);
    assert.equal(editor.state.draft?.nodes.length, 2);
  });

  it("a missing workflow is an error with words, not a crash", async () => {
    const api = new FakeApi(workflow([]));
    api.getWorkflow = async () => {
      throw Object.assign(new Error("gone"), { status: 404, code: "WORKFLOW_NOT_FOUND" });
    };
    const editor = new WorkflowEditor(api, "wf-1", { timers: new FakeTimers(), remote: null });
    await editor.load();
    assert.equal(editor.state.status, "error");
    assert.match(editor.state.loadError ?? "", /no longer exists/);
  });
});

describe("editor-store: autosave", () => {
  it("saves 600 ms after the last change, once, with the revision the draft is based on", async () => {
    const { api, timers, editor } = await setup();
    editor.change(rename("One"));
    timers.advance(AUTOSAVE_DELAY_MS - 100);
    editor.change(rename("Two"));
    timers.advance(AUTOSAVE_DELAY_MS - 1);
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
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    const body = api.puts[0]!.workflow as Record<string, unknown>;
    for (const key of ["id", "revision", "createdAt", "updatedAt"]) assert.equal(key in body, false, key);
  });

  it("serializes saves: a change during a save is saved right after it, on the new revision", async () => {
    const { api, timers, editor } = await setup();
    api.hold = true;
    editor.change(rename("First"));
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    assert.equal(api.puts.length, 1);
    editor.change(rename("Second"));
    timers.advance(AUTOSAVE_DELAY_MS);
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
    timers.advance(AUTOSAVE_DELAY_MS);
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
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    assert.equal(api.server.enabled, false);
    assert.equal(api.server.name, "Broken");
    assert.equal(editor.state.draft?.enabled, false);
    assert.match(editor.state.notice ?? "", /disabled/);
  });
});

describe("editor-store: conflicts", () => {
  it("a 409 raises the banner and stops autosaving", async () => {
    const { api, timers, editor } = await setup();
    api.saveElsewhere(rename("Theirs"));
    editor.change(rename("Mine"));
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    assert.deepEqual(editor.state.conflict, { kind: "save" });
    assert.equal(editor.state.saveState, "conflict");
    editor.change(rename("Mine again"));
    timers.advance(AUTOSAVE_DELAY_MS * 3);
    await settle();
    assert.equal(api.puts.length, 1, "no autosave while in conflict");
  });

  it("Reload takes their copy and drops the edits (and the undo history)", async () => {
    const { api, timers, editor } = await setup();
    api.saveElsewhere(rename("Theirs"));
    editor.change(rename("Mine"));
    timers.advance(AUTOSAVE_DELAY_MS);
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
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    await editor.keepMine();
    await settle();
    assert.equal(editor.state.conflict, null);
    assert.equal(api.server.name, "Mine");
    assert.equal(editor.state.saveState, "saved");
    assert.equal(editor.state.revision, api.server.revision);
  });
});

describe("editor-store: remote changes", () => {
  it("a newer revision while clean reloads silently", async () => {
    const { api, remote, editor } = await setup();
    api.saveElsewhere(rename("From the MCP"));
    remote.announce(2);
    await settle();
    assert.equal(api.gets, 2);
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

  it("the echo of our own save reloads nothing", async () => {
    const { api, timers, remote, editor } = await setup();
    api.hold = true;
    editor.change(rename("Mine"));
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    // The event can land before the save's answer.
    remote.announce(2);
    api.held.shift()!.release();
    await settle();
    remote.announce(2);
    await settle();
    assert.equal(api.gets, 1);
    assert.equal(editor.state.conflict, null);
    assert.equal(editor.state.draft?.name, "Mine");
  });
});

describe("editor-store: history, patches, enabling, validation", () => {
  it("undo and redo swap whole drafts; a typing burst is one step", async () => {
    const { timers, editor } = await setup();
    editor.change(rename("A"), { coalesce: "name" });
    timers.time += 100;
    editor.change(rename("AB"), { coalesce: "name" });
    timers.time += 100;
    editor.change(rename("ABC"), { coalesce: "name" });
    assert.equal(editor.state.canUndo, true);
    editor.undo();
    assert.equal(editor.state.draft?.name, "Test");
    assert.equal(editor.state.canRedo, true);
    editor.redo();
    assert.equal(editor.state.draft?.name, "ABC");
  });

  it("undo drops a selection of blocks the older draft does not have", async () => {
    const { editor } = await setup();
    editor.change((draft) => ({ ...draft, nodes: [...draft.nodes, node("x", "code", {}, { name: "New" })] }), {
      select: { nodeIds: ["x"], edgeIds: [] }
    });
    editor.undo();
    assert.deepEqual(editor.state.selection.nodeIds, []);
  });

  it("a rename through patch ops rewrites the references to the old name", async () => {
    const initial = workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("a", "agent", {}, { name: "Review" }),
        node("h", "http", { url: "https://x.test/{{ nodes.Review.output.text }}" }, { name: "Post" })
      ],
      [edge("t", "a"), edge("a", "h")]
    );
    const { editor } = await setup(initial);
    assert.equal(editor.applyOps([{ op: "rename_node", node: "a", to: "Critique" }]), null);
    const http = editor.state.draft?.nodes.find((candidate) => candidate.id === "h");
    assert.equal(http?.type === "http" ? http.config.url : null, "https://x.test/{{ nodes.Critique.output.text }}");
    assert.match(editor.applyOps([{ op: "rename_node", node: "h", to: "Critique" }]) ?? "", /Critique/);
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
    timers.advance(VALIDATE_DELAY_MS);
    assert.ok(editor.state.problems.some((problem) => problem.code === "unknown_reference" && problem.nodeId === "a"));
  });
});

describe("editor-store: review fixes", () => {
  it("a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id)", async () => {
    const first = Object.assign(new FakeApi(workflow([node("t", "trigger.manual")])), { connection: { id: "c1" } });
    const timers = new FakeTimers();
    const editor = workflowEditorFor(first, "wf-1", { timers, remote: null });
    await settle();
    editor.change(rename("Typing"));
    const second = Object.assign(new FakeApi(first.server), { connection: { id: "c1" } });
    const again = workflowEditorFor(second, "wf-1", { timers, remote: null });
    assert.equal(again, editor, "same editor");
    assert.equal(again.state.draft?.name, "Typing");
    timers.advance(AUTOSAVE_DELAY_MS);
    await settle();
    assert.equal(first.puts.length, 0, "the old client is not used any more");
    assert.equal(second.puts.length, 1);
    const other = Object.assign(new FakeApi(first.server), { connection: { id: "c2" } });
    assert.notEqual(workflowEditorFor(other, "wf-1", { timers, remote: null }), editor, "another connection gets its own");
    resetWorkflowEditors();
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

  it("the editor's own Enable toggle does not trigger a reload", async () => {
    const { api, remote, editor } = await setup();
    const realPatch = api.patchWorkflow.bind(api);
    api.patchWorkflow = async (id, req) => {
      const answer = await realPatch(id, req);
      remote.announce(api.server.revision); // the echo lands before the answer
      return answer;
    };
    assert.equal(await editor.setEnabled(true), null);
    await settle();
    assert.equal(api.gets, 1, "no reload");
    assert.equal(editor.state.revision, 2);
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
    timers.advance(AUTOSAVE_DELAY_MS);
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
    const timers = new FakeTimers();
    const editor = workflowEditorFor(api, "wf-9", { timers, remote: null });
    await settle();
    editor.change(rename("Leaving"));
    flushAllWorkflowEditors();
    await settle();
    assert.equal(api.server.name, "Leaving");
    resetWorkflowEditors();
  });
});
