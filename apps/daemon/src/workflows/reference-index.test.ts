// The workflow reference index: what it maps (calls, transitive callers, saved-prompt uses), how the
// definitions store keeps it (one synchronous step with every write; rebuilt by `load`), how it fails
// closed (unreadable records, an unreadable file, not loaded yet), the `expectCallers` precondition
// that closes the race between a card and its write, and the read-only routes.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import {
  workflowRoutes,
  type CreateWorkflowRequest,
  type ProfileReferencesResponse,
  type PromptReferencesResponse,
  type Workflow,
  type WorkflowPatchOp,
  type WorkflowReferencesResponse
} from "@orquester/api";
import { WorkflowError } from "./errors.ts";
import { WorkflowReferenceIndex } from "./reference-index.ts";
import { FileRunStore } from "./run-store.ts";
import { registerWorkflowRoutes } from "./routes.ts";
import { WorkflowSecretsService } from "./secrets.ts";
import { WorkflowService } from "./service.ts";

const roots: string[] = [];
const flushers: { flush(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(flushers.map((store) => store.flush()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const quiet = { warn: () => undefined, error: () => undefined };
const STAMP = "2026-10-16T10:00:00.000Z";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-refs-"));
  roots.push(dir);
  return dir;
}

// ---- Fixtures (stored data, independent of the creator) ----------------------------------------

const trigger = { id: "t", name: "Start", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} };
const sub = (id: string, target: string) => ({ id, name: `Run ${id}`, type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: target } });
const ask = (id: string, promptId: string) => ({ id, name: `Ask ${id}`, type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "saved", promptId }, chain: [{ agent: "claude" }] } });

function stored(id: string, nodes: unknown[] = [], over: Partial<Workflow> = {}): Workflow {
  return {
    id, name: id.toUpperCase(), enabled: false, revision: 0,
    project: { kind: "existing", projectPath: `/w/acme/${id}` },
    settings: { overlap: "skip", maxConcurrent: 2, timezone: "UTC", notify: { onFailure: true, onSuccess: false }, keepFailedTempDays: 3 },
    nodes: [trigger, ...nodes], edges: [], createdAt: STAMP, updatedAt: STAMP,
    ...over
  } as Workflow;
}

const ids = (answer: { callers: { workflowId: string }[] | null }) => answer.callers?.map((caller) => caller.workflowId) ?? null;

// ---- The index alone ---------------------------------------------------------------------------

test("index: direct and transitive callers, cycles, calls each once; prompt uses with their blocks, a disabled block too", () => {
  const index = new WorkflowReferenceIndex();
  index.rebuild({
    workflows: [
      stored("leaf"),
      stored("mid", [sub("a", "leaf"), sub("b", "leaf")]),
      stored("top", [sub("c", "mid")], { enabled: true }),
      stored("loop1", [sub("d", "loop2")]),
      stored("loop2", [sub("e", "loop1"), { ...ask("x", "p1"), disabled: true }, ask("y", "p1")]),
      stored("other", [ask("z", "p2"), { id: "code", name: "Code", type: "code", position: { x: 0, y: 0 }, config: { source: "p1", prompt: { kind: "saved", promptId: "p1" } } }])
    ]
  });
  assert.deepEqual(index.calls("mid"), ["leaf"], "two blocks running one workflow: one call");
  assert.deepEqual(index.calls("nope"), []);
  assert.deepEqual(ids(index.callers("leaf")), ["mid", "top"], "nearest first, through others too");
  assert.deepEqual(index.callers("leaf").callers?.find((caller) => caller.workflowId === "top"), {
    workflowId: "top", name: "TOP", enabled: true, revision: 0, project: { kind: "existing", projectPath: "/w/acme/top" }
  });
  assert.deepEqual(ids(index.callers("top")), []);
  assert.deepEqual(ids(index.callers("loop1")), ["loop2"], "a cycle stops, never names the workflow itself");
  assert.deepEqual(ids(index.callers("ghost")), [], "an id nobody runs");
  assert.equal(index.callersKey("leaf"), "mid,top");
  const p1 = index.promptUses("p1");
  assert.deepEqual(p1.workflows.map((use) => [use.workflowId, use.nodes.map((node) => node.id)]), [["loop2", ["x", "y"]]], "agent blocks only; a disabled one counts");
  assert.equal(p1.unknownReason, undefined);
  assert.deepEqual(index.promptUses("p9").workflows, []);
});

test("index fails closed: before a rebuild, while the file is unreadable, and for any id an unreadable record mentions", () => {
  const index = new WorkflowReferenceIndex();
  assert.equal(index.callers("x").callers, null, "not loaded: unknown, never none");
  assert.match(index.callers("x").unknownReason ?? "", /not loaded/);
  assert.match(index.promptUses("p").unknownReason ?? "", /not loaded/);
  assert.equal(index.callersKey("x"), null);
  index.rebuild({ workflows: [stored("a")], unavailable: "workflows.json could not be read (EACCES)" });
  assert.equal(index.callers("a").callers, null);
  assert.match(index.promptUses("p").unknownReason ?? "", /EACCES/);
  // Records a newer build wrote: whatever strings they hold may be references.
  index.rebuild({
    workflows: [stored("child"), stored("mid", [sub("s", "child")]), stored("lone")],
    unreadable: [{ id: "future", nodes: [{ type: "workflow.v2", call: { target: "mid" } }, { type: "agent", prompt: { ref: "saved:p7" } }] }, "not even an object", 42]
  });
  assert.equal(index.callers("mid").callers, null, "named by an unreadable record");
  assert.equal(index.callers("child").callers, null, "its caller is named: it may be run through it");
  assert.deepEqual(ids(index.callers("lone")), [], "an id no unreadable record mentions stays known");
  assert.ok(index.promptUses("p7").unknownReason);
  assert.equal(index.promptUses("p8").unknownReason, undefined);
});

test("index: Agent Profile uses — agent blocks with a profileId, a disabled one too; re-targeted, deleted, and unknown when an unreadable record names it", () => {
  const launch = (id: string, profileId: string, over: Record<string, unknown> = {}) => ({ ...ask(id, "p1"), config: { ...ask(id, "p1").config, profileId }, ...over });
  const index = new WorkflowReferenceIndex();
  index.rebuild({
    workflows: [
      stored("a", [launch("x", "prof-1"), launch("y", "prof-1", { disabled: true })]),
      stored("b", [launch("z", "prof-2"), ask("g", "p1"), { id: "c", name: "Code", type: "code", position: { x: 0, y: 0 }, config: { source: "", profileId: "prof-1" } }])
    ]
  });
  assert.deepEqual(index.profileUses("prof-1").workflows.map((use) => [use.workflowId, use.nodes.map((node) => node.id)]), [["a", ["x", "y"]]], "agent blocks only");
  assert.deepEqual(index.profileUses("prof-2").workflows.map((use) => use.workflowId), ["b"]);
  assert.deepEqual(index.profileUses("prof-9").workflows, []);
  assert.deepEqual(index.promptUses("p1").workflows.map((use) => use.workflowId), ["a", "b"], "prompt uses are unchanged beside them");
  index.set(stored("a", [launch("x", "prof-2")], { revision: 1 }));
  assert.deepEqual(index.profileUses("prof-1").workflows, [], "re-targeted: the old use is gone");
  assert.deepEqual(index.profileUses("prof-2").workflows.map((use) => use.workflowId), ["a", "b"]);
  index.delete("b");
  assert.deepEqual(index.profileUses("prof-2").workflows.map((use) => use.workflowId), ["a"]);
  index.rebuild({ workflows: [stored("a")], unreadable: [{ id: "future", nodes: [{ type: "agent", launch: { profile: "prof-7" } }] }] });
  assert.ok(index.profileUses("prof-7").unknownReason, "an unreadable record mentions it: unknown, never none");
  assert.equal(index.profileUses("prof-8").unknownReason, undefined);
  assert.match(new WorkflowReferenceIndex().profileUses("prof-1").unknownReason ?? "", /not loaded/);
});

// ---- Kept by the definitions store -------------------------------------------------------------

function createRequest(name: string, nodes: CreateWorkflowRequest["nodes"] = []): CreateWorkflowRequest {
  return { name, project: { kind: "existing", projectPath: "/w/acme/app" }, settings: { timezone: "UTC" }, nodes: [{ id: "t", type: "trigger.manual", name: "Start" }, ...(nodes ?? [])] };
}

async function service(file: string): Promise<WorkflowService> {
  const store = new WorkflowService({ file, logger: quiet });
  flushers.push(store);
  await store.load();
  return store;
}

async function rejects(promise: Promise<unknown>, status: number, code: string): Promise<WorkflowError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkflowError, String(error));
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("the store keeps the index through create, patch, replace, duplicate and delete; a reload rebuilds the same answers from disk", async () => {
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  const store = await service(file);
  const child = (await store.create(createRequest("Child"))).workflow;
  const parent = (await store.create(createRequest("Parent", [{ id: "s", type: "workflow", name: "Call", config: { workflowId: child.id } }]))).workflow;
  assert.deepEqual(ids(store.references.callers(child.id)), [parent.id]);
  // Patched: the block re-targeted to nothing it knows, then back.
  const other = (await store.create(createRequest("Other"))).workflow;
  const retarget: WorkflowPatchOp[] = [{ op: "update_node", node: "Call", set: { config: { workflowId: other.id } } }];
  await store.patch(parent.id, { revision: 0, ops: retarget });
  assert.deepEqual(ids(store.references.callers(child.id)), []);
  assert.deepEqual(ids(store.references.callers(other.id)), [parent.id]);
  // Renamed block: still the same reference.
  await store.patch(parent.id, { revision: 1, ops: [{ op: "rename_node", node: "Call", to: "RunOther" }] });
  assert.deepEqual(ids(store.references.callers(other.id)), [parent.id]);
  // Replaced whole: uses a saved prompt instead.
  const current = store.require(parent.id);
  const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...body } = current;
  await store.replace(parent.id, {
    revision: current.revision,
    workflow: { ...body, nodes: [current.nodes[0]!, { id: "a", name: "Ask", type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "saved", promptId: "p1" }, chain: [{ agent: "claude", model: "opus" }] } }] } as never
  });
  assert.deepEqual(ids(store.references.callers(other.id)), []);
  assert.deepEqual(store.references.promptUses("p1").workflows.map((use) => use.workflowId), [parent.id]);
  await store.patch(parent.id, { revision: store.require(parent.id).revision, ops: [{ op: "rename_node", node: "Ask", to: "AskRenamed" }] });
  assert.deepEqual(store.references.promptUses("p1").workflows[0]!.nodes, [{ id: "a", name: "AskRenamed" }], "the prompt use keeps its current block name");
  // Duplicated: the copy uses it too.
  const copy = (await store.duplicate(parent.id)).workflow;
  assert.deepEqual(store.references.promptUses("p1").workflows.map((use) => use.workflowId), [parent.id, copy.id]);
  // Deleted.
  await store.delete(copy.id);
  assert.deepEqual(store.references.promptUses("p1").workflows.map((use) => use.workflowId), [parent.id]);
  await store.patch(other.id, { revision: 0, ops: [{ op: "add_node", node: { id: "s2", type: "workflow", name: "CallChild", config: { workflowId: child.id } } }] });
  await store.flush();
  const before = { callers: ids(store.references.callers(child.id)), uses: store.references.promptUses("p1").workflows.map((use) => use.workflowId) };
  // Startup: rebuilt from disk, the same answers.
  const reloaded = await service(file);
  assert.deepEqual({ callers: ids(reloaded.references.callers(child.id)), uses: reloaded.references.promptUses("p1").workflows.map((use) => use.workflowId) }, before);
  assert.deepEqual(before.callers, [other.id]);
});

test("startup tolerates other builds' records: an unreadable one that names a workflow makes its callers unknown; an unreadable file makes every answer unknown", async () => {
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    workflows: [
      stored("child"),
      stored("parent", [sub("s", "child")], { futureField: { kept: true } } as never),
      stored("lone"),
      { id: "newer", name: "From a newer build", nodes: [{ id: "n", type: "workflow.remote", config: { workflowId: "lone", promptId: "p1" } }] }
    ]
  }));
  const store = await service(file);
  assert.deepEqual(store.list().map((workflow) => workflow.id), ["child", "parent", "lone"]);
  assert.deepEqual(ids(store.references.callers("child")), ["parent"], "an unknown field on a readable record is tolerated");
  assert.equal(store.references.callers("lone").callers, null, "named by the record this build cannot read: unknown, never none");
  assert.ok(store.references.promptUses("p1").unknownReason);
  // Fail closed in the precondition too: the write is refused rather than judged on a guess.
  await rejects(store.delete("lone", undefined, []), 409, "CALLERS_CHANGED");
  assert.ok(store.get("lone"));

  // A file that cannot be read at all (a directory where it should be).
  const blockedDir = await scratch();
  await mkdir(join(blockedDir, "workflows.json"));
  const blocked = await service(join(blockedDir, "workflows.json"));
  assert.ok(blocked.blocked);
  assert.equal(blocked.references.callers("anything").callers, null);
  assert.match(blocked.references.promptUses("p1").unknownReason ?? "", /could not be read/);
});

test("race: an answer never lags a save that landed, and a write whose callers changed since the card is refused (CALLERS_CHANGED), nothing saved", async () => {
  const dir = await scratch();
  const store = await service(join(dir, "workflows.json"));
  const target = (await store.create(createRequest("Target"))).workflow;
  // What a card (or a grant's check) saw: no callers.
  const seen = store.references.callers(target.id);
  assert.deepEqual(ids(seen), []);
  // A create that runs it is in flight (not awaited): the index already answers with it — the map
  // and the index change in the same synchronous step, before the file write.
  const inFlight = store.create(createRequest("Caller", [{ id: "s", type: "workflow", name: "Call", config: { workflowId: target.id } }]));
  const during = store.references.callers(target.id);
  assert.equal(during.callers?.length, 1, "never a stale \"no callers\" while the save is in flight");
  assert.ok(during.version > seen.version);
  const caller = (await inFlight).workflow;
  // The write approved on the old answer is refused in the same step it would apply: nothing saved.
  const expectCallers = seen.callers!.map((entry) => entry.workflowId);
  await rejects(store.patch(target.id, { revision: 0, ops: [{ op: "set_name", name: "Changed" }], expectCallers }), 409, "CALLERS_CHANGED");
  assert.equal(store.require(target.id).name, "Target");
  assert.equal(store.require(target.id).revision, 0);
  await rejects(store.delete(target.id, undefined, expectCallers), 409, "CALLERS_CHANGED");
  assert.ok(store.get(target.id));
  // With the callers as they are now: applied.
  await store.patch(target.id, { revision: 0, ops: [{ op: "set_name", name: "Changed" }], expectCallers: [caller.id] });
  assert.equal(store.require(target.id).name, "Changed");
  // A deleted caller: the old expectation is stale again.
  await store.delete(caller.id);
  await rejects(store.patch(target.id, { revision: 1, ops: [{ op: "set_name", name: "Again" }], expectCallers: [caller.id] }), 409, "CALLERS_CHANGED");
  await rejects(store.patch(target.id, { revision: 1, ops: [{ op: "set_name", name: "Again" }], expectCallers: "x" as never }), 400, "INVALID_REQUEST");
  await store.delete(target.id, 1, []);
  assert.equal(store.get(target.id), null);
});

// ---- The routes --------------------------------------------------------------------------------

test("routes: GET the references of a workflow, a saved prompt and an Agent Profile; DELETE ?expectCallers= is the same precondition", async () => {
  const dir = await scratch();
  const secrets = new WorkflowSecretsService({ file: join(dir, "workflow-secrets.json"), logger: quiet });
  await secrets.load();
  const store = await service(join(dir, "workflows.json"));
  const runStore = new FileRunStore({ dir: join(dir, "workflow-runs"), logger: quiet });
  await runStore.init();
  flushers.push(secrets, runStore);
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, {
    service: store, secrets, runStore, engine: () => null, savedPromptIds: () => ["p1"],
    projectPathFilter: (projectPath) => (projectPath.startsWith("/w/") ? { path: projectPath, workspace: projectPath.split("/")[2]! } : null)
  });
  await app.ready();
  after(() => app.close());
  const child = (await store.create(createRequest("Child"))).workflow;
  const parent = (await store.create({ ...createRequest("Parent", [{ id: "s", type: "workflow", name: "Call", config: { workflowId: child.id } }, { id: "a", type: "agent", name: "Ask", config: { prompt: { kind: "saved", promptId: "p1" }, profileId: "prof-1" } }]), project: { kind: "temp", workspace: "beta", source: { kind: "empty" } } })).workflow;

  const refs = (await app.inject({ method: "GET", url: workflowRoutes.workflowReferences(child.id) })).json() as WorkflowReferencesResponse;
  assert.deepEqual({ ...refs, version: 0 }, {
    version: 0, workflowId: child.id, calls: [],
    callers: [{ workflowId: parent.id, name: "Parent", enabled: false, revision: 0, project: { kind: "temp", workspace: "beta", source: { kind: "empty" } }, workspace: "beta" }]
  });
  assert.ok(refs.version > 0);
  const parentRefs = (await app.inject({ method: "GET", url: workflowRoutes.workflowReferences(parent.id) })).json() as WorkflowReferencesResponse;
  assert.deepEqual([parentRefs.calls, parentRefs.callers], [[child.id], []]);
  const uses = (await app.inject({ method: "GET", url: workflowRoutes.promptReferences("p1") })).json() as PromptReferencesResponse;
  assert.deepEqual(uses.workflows.map((use) => [use.workflowId, use.workspace, use.nodes]), [[parent.id, "beta", [{ id: "a", name: "Ask" }]]]);
  assert.equal(uses.unknownReason, undefined);
  const childUses = (await app.inject({ method: "GET", url: workflowRoutes.promptReferences("p9") })).json() as PromptReferencesResponse;
  assert.deepEqual(childUses.workflows, []);
  const profileUses = (await app.inject({ method: "GET", url: workflowRoutes.profileReferences("prof-1") })).json() as ProfileReferencesResponse;
  assert.deepEqual([profileUses.profileId, profileUses.workflows.map((use) => [use.workflowId, use.workspace, use.nodes])], ["prof-1", [[parent.id, "beta", [{ id: "a", name: "Ask" }]]]]);
  assert.deepEqual(((await app.inject({ method: "GET", url: workflowRoutes.profileReferences("prof-9") })).json() as ProfileReferencesResponse).workflows, []);

  const stale = await app.inject({ method: "DELETE", url: `${workflowRoutes.workflow(child.id)}?expectCallers=` });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "CALLERS_CHANGED");
  assert.ok(store.get(child.id));
  const patched = await app.inject({ method: "POST", url: workflowRoutes.patch(child.id), payload: { revision: 0, ops: [{ op: "set_name", name: "C2" }], expectCallers: [] } });
  assert.equal(patched.statusCode, 409);
  const gone = await app.inject({ method: "DELETE", url: `${workflowRoutes.workflow(child.id)}?expectCallers=${parent.id}` });
  assert.equal(gone.statusCode, 204);
  assert.equal(store.get(child.id), null);
});

test("a load that fails part-way never leaves a known index: every answer is unknown, and the error is rethrown", async () => {
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  // A readable child and caller, and a record this build cannot read: the map is filled before the warning.
  await writeFile(file, JSON.stringify({ version: 1, workflows: [stored("child"), stored("parent", [sub("s", "child")]), { id: "newer" }] }));
  const store = new WorkflowService({ file, logger: { warn: () => { throw new Error("logger down"); }, error: () => undefined } });
  flushers.push(store);
  await assert.rejects(store.load(), /logger down/);
  const answer = store.references.callers("child");
  assert.equal(answer.callers, null, "never the partial map as known");
  assert.match(answer.unknownReason ?? "", /could not be loaded/);
  assert.match(store.references.promptUses("p1").unknownReason ?? "", /could not be loaded/);
});

test("routes without a wired projectPathFilter name no guessed workspace for an existing project (a temp project's stays)", async () => {
  const dir = await scratch();
  const secrets = new WorkflowSecretsService({ file: join(dir, "workflow-secrets.json"), logger: quiet });
  await secrets.load();
  const store = await service(join(dir, "workflows.json"));
  const runStore = new FileRunStore({ dir: join(dir, "workflow-runs"), logger: quiet });
  await runStore.init();
  flushers.push(secrets, runStore);
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, { service: store, secrets, runStore, engine: () => null, savedPromptIds: () => [] });
  await app.ready();
  after(() => app.close());
  const child = (await store.create(createRequest("Child"))).workflow;
  const callNode = { id: "s", type: "workflow" as const, name: "Call", config: { workflowId: child.id } };
  const existing = (await store.create(createRequest("Existing", [callNode]))).workflow;
  const temp = (await store.create({ ...createRequest("Temp", [callNode]), project: { kind: "temp", workspace: "beta", source: { kind: "empty" } } })).workflow;
  const refs = (await app.inject({ method: "GET", url: workflowRoutes.workflowReferences(child.id) })).json() as WorkflowReferencesResponse;
  assert.deepEqual(refs.callers?.map((caller) => [caller.workflowId, caller.workspace]), [[existing.id, undefined], [temp.id, "beta"]]);
});
