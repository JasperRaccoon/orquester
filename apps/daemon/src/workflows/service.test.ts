import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WORKFLOW_LIMITS, WORKFLOWS_CHANNEL, type CreateWorkflowRequest, type Workflow } from "@orquester/api";
import { WorkflowError } from "./errors.ts";
import { publishWorkflowEvents, WorkflowService } from "./service.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-service-"));
  roots.push(dir);
  return dir;
}

function quietLogger() {
  const lines: string[] = [];
  return { lines, logger: { warn: (...a: unknown[]) => void lines.push(`warn: ${a.join(" ")}`), error: (...a: unknown[]) => void lines.push(`error: ${a.join(" ")}`) } };
}

function sequence(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const T0 = new Date("2026-09-28T10:00:00.000Z");

function makeService(file: string, extra: Partial<ConstructorParameters<typeof WorkflowService>[0]> = {}) {
  const { lines, logger } = quietLogger();
  const service = new WorkflowService({ file, logger, now: () => T0, mintId: sequence(), ...extra });
  return { service, lines };
}

function request(overrides: Partial<CreateWorkflowRequest> = {}): CreateWorkflowRequest {
  return {
    name: "Nightly",
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start" },
      { id: "c", type: "code", name: "Run" }
    ],
    edges: [{ source: "t", target: "c" }],
    ...overrides
  };
}

/** A request whose sub-workflow block has no target: a validation ERROR, but schema-valid. */
function requestWithErrors(overrides: Partial<CreateWorkflowRequest> = {}): CreateWorkflowRequest {
  return request({
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start" },
      { id: "s", type: "workflow", name: "Child" }
    ],
    edges: [{ source: "t", target: "s" }],
    ...overrides
  });
}

async function rejects(promise: Promise<unknown>, status: number, code: string): Promise<WorkflowError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkflowError, `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("create → read back; persisted atomically at 0600; a reload lists it", async () => {
  const dir = await scratch();
  const file = join(dir, "daemon", "workflows.json");
  const { service } = makeService(file);
  await service.load();
  const created = await service.create(request());
  assert.equal(created.workflow.name, "Nightly");
  assert.equal(created.workflow.revision, 0);
  assert.equal(created.workflow.enabled, false);
  assert.deepEqual(created.problems.filter((p) => p.severity === "error"), []);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(dir, "daemon"))).filter((f) => f.endsWith(".tmp")), []);

  const { service: again } = makeService(file);
  await again.load();
  assert.deepEqual(again.list().map((w) => w.id), [created.workflow.id]);
  assert.deepEqual(again.get(created.workflow.id), created.workflow);
});

test("tolerant load: rejected entries and unknown keys are written back verbatim and never listed", async () => {
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  const { service: seed } = makeService(file);
  await seed.load();
  const good = (await seed.create(request())).workflow;
  const newerShape = { id: "future", name: "From a newer build", project: { kind: "cloud" }, createdAt: "x" };
  const onDisk = JSON.parse(await readFile(file, "utf8")) as { workflows: unknown[] };
  await writeFile(
    file,
    JSON.stringify({ version: 1, workflows: [...onDisk.workflows, newerShape, good], futureKey: { keep: true } })
  );

  const { service, lines } = makeService(file);
  await service.load();
  assert.deepEqual(service.list().map((w) => w.id), [good.id], "the malformed entry and the repeated id are not listed");
  assert.ok(lines.some((line) => line.includes("2 workflow(s) this build cannot read")));

  await service.patch(good.id, { revision: good.revision, ops: [{ op: "set_name", name: "Renamed" }] });
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & { workflows: Record<string, unknown>[] };
  assert.deepEqual(written.futureKey, { keep: true });
  assert.deepEqual(written.workflows[1], newerShape);
  assert.equal(written.workflows[2]!.id, good.id, "the repeated id rides along verbatim");
  assert.equal((written.workflows[0] as Workflow).name, "Renamed");
});

test("a corrupt or foreign-version file is moved aside, never overwritten", async () => {
  for (const content of ["{not json", JSON.stringify({ version: 2, workflows: [] })]) {
    const dir = await scratch();
    const file = join(dir, "workflows.json");
    await writeFile(file, content);
    const { service, lines } = makeService(file);
    await service.load();
    assert.deepEqual(service.list(), []);
    const names = await readdir(dir);
    const aside = names.find((name) => name.startsWith("workflows.json.corrupt-"));
    assert.ok(aside, `moved aside: ${names.join(", ")}`);
    assert.equal(await readFile(join(dir, aside), "utf8"), content);
    assert.ok(lines.some((line) => line.startsWith("warn:")));
    // Writable afterwards: a fresh file.
    await service.create(request());
    assert.equal(service.list().length, 1);
  }
});

test("an unreadable file blocks every mutation with 503 WORKFLOWS_UNAVAILABLE and is left alone", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a 0000 file");
    return;
  }
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  await writeFile(file, JSON.stringify({ version: 1, workflows: [] }));
  await chmod(file, 0o000);
  const { service } = makeService(file);
  await service.load();
  assert.ok(service.blocked);
  await rejects(service.create(request()), 503, "WORKFLOWS_UNAVAILABLE");
  await chmod(file, 0o600);
  assert.equal(await readFile(file, "utf8"), JSON.stringify({ version: 1, workflows: [] }));
});

test("revisions: +1 on every write, a stale revision is a 409 naming the current one", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const created = (await service.create(request())).workflow;

  const patched = (await service.patch(created.id, { revision: 0, ops: [{ op: "set_name", name: "Second" }] })).workflow;
  assert.equal(patched.revision, 1);
  const { id: _id, revision: _rev, createdAt: _c, updatedAt: _u, ...body } = patched;
  const replaced = (await service.replace(created.id, { revision: 1, workflow: { ...body, name: "Third" } })).workflow;
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.name, "Third");
  assert.equal(replaced.createdAt, created.createdAt);

  const conflict = await rejects(service.patch(created.id, { revision: 1, ops: [] }), 409, "REVISION_CONFLICT");
  assert.match(conflict.message, /current revision is 2/);
  await rejects(service.replace(created.id, { revision: 0, workflow: body }), 409, "REVISION_CONFLICT");
  await rejects(service.delete(created.id, 1), 409, "REVISION_CONFLICT");
  await rejects(service.patch("nope", { revision: 0, ops: [] }), 404, "WORKFLOW_NOT_FOUND");
});

test("a bad patch op is 400 INVALID_WORKFLOW naming the op, and changes nothing", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const created = (await service.create(request())).workflow;
  const error = await rejects(
    service.patch(created.id, {
      revision: 0,
      ops: [
        { op: "set_name", name: "Changed" },
        { op: "remove_node", node: "NoSuchBlock" }
      ]
    }),
    400,
    "INVALID_WORKFLOW"
  );
  assert.match(error.message, /^Operation 1:/);
  assert.equal(service.get(created.id)!.name, "Nightly");
  assert.equal(service.get(created.id)!.revision, 0);
});

test("a definition with errors saves disabled, but can never be (or stay) enabled", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const saved = await service.create(requestWithErrors());
  assert.ok(saved.problems.some((p) => p.severity === "error" && p.code === "subworkflow_unset"));
  assert.equal(saved.workflow.enabled, false);

  const refusal = await rejects(
    service.patch(saved.workflow.id, { revision: 0, ops: [{ op: "set_enabled", enabled: true }] }),
    400,
    "INVALID_WORKFLOW"
  );
  assert.ok(refusal.problems?.some((p) => p.code === "subworkflow_unset"));
  assert.equal(service.get(saved.workflow.id)!.enabled, false);
  await rejects(service.create(requestWithErrors({ enabled: true })), 400, "INVALID_WORKFLOW");

  // An enabled, valid workflow refuses an edit that introduces an error.
  const valid = (await service.create(request({ enabled: true }))).workflow;
  assert.equal(valid.enabled, true);
  await rejects(
    service.patch(valid.id, { revision: 0, ops: [{ op: "add_node", node: { type: "workflow", name: "Broken" } }] }),
    400,
    "INVALID_WORKFLOW"
  );
  assert.equal(service.get(valid.id)!.nodes.length, 2);
});

test("a schema-invalid replace is refused whole", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const created = (await service.create(request())).workflow;
  await rejects(
    service.replace(created.id, { revision: 0, workflow: { ...created, project: { kind: "moon" } } as never }),
    400,
    "INVALID_WORKFLOW"
  );
  await rejects(service.replace(created.id, { revision: 0 } as never), 400, "INVALID_REQUEST");
});

test("limits: the workflow count and the definition size are LIMIT_EXCEEDED", async () => {
  const dir = await scratch();
  const file = join(dir, "workflows.json");
  const stamp = T0.toISOString();
  const many = Array.from({ length: WORKFLOW_LIMITS.maxWorkflows }, (_, i) => ({
    id: `wf-${i}`,
    name: `W${i}`,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    createdAt: stamp,
    updatedAt: stamp
  }));
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, workflows: many }));
  const { service } = makeService(file);
  await service.load();
  assert.equal(service.list().length, WORKFLOW_LIMITS.maxWorkflows);
  await rejects(service.create(request()), 400, "LIMIT_EXCEEDED");
  await rejects(service.duplicate("wf-0"), 400, "LIMIT_EXCEEDED");

  const dir2 = await scratch();
  const { service: small } = makeService(join(dir2, "workflows.json"));
  await small.load();
  const created = (await small.create(request())).workflow;
  const huge = "x".repeat(WORKFLOW_LIMITS.maxDefinitionBytes);
  await rejects(
    small.patch(created.id, { revision: 0, ops: [{ op: "set_name", name: "Big", description: huge }] }),
    400,
    "LIMIT_EXCEEDED"
  );
});

test("duplicate: new ids for the workflow, blocks and connections; '(copy)'; disabled; pins follow", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const source = (await service.create(request({ enabled: true }))).workflow;
  const pinned = (
    await service.patch(source.id, { revision: 0, ops: [{ op: "set_pinned", node: "Run", output: { ok: 1 } }] })
  ).workflow;
  const copy = (await service.duplicate(source.id)).workflow;
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, "Nightly (copy)");
  assert.equal(copy.enabled, false);
  assert.equal(copy.revision, 0);
  const sourceNodeIds = new Set(pinned.nodes.map((n) => n.id));
  assert.ok(copy.nodes.every((n) => !sourceNodeIds.has(n.id)));
  assert.deepEqual(copy.nodes.map((n) => n.name), pinned.nodes.map((n) => n.name));
  const copyIds = new Set(copy.nodes.map((n) => n.id));
  assert.ok(copy.edges.every((e) => copyIds.has(e.source) && copyIds.has(e.target) && e.id !== pinned.edges[0]!.id));
  const runId = copy.nodes.find((n) => n.name === "Run")!.id;
  assert.deepEqual(copy.pinned, { [runId]: { ok: 1 } });
  assert.equal(service.list().length, 2);
});

test("events: upserted after every write, deleted after a delete; the bridge publishes summaries", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"));
  await service.load();
  const published: { channel: string; type: string; payload: unknown }[] = [];
  publishWorkflowEvents({
    service,
    broadcaster: { publish: (channel, type, payload) => void published.push({ channel, type, payload }) },
    summarize: (workflow) => ({ id: workflow.id, name: workflow.name }) as never
  });
  const changed: string[] = [];
  const deleted: string[] = [];
  const offChanged = service.onChanged((w) => changed.push(`${w.id}@${w.revision}`));
  service.onDeleted((id) => deleted.push(id));

  const created = (await service.create(request())).workflow;
  await service.patch(created.id, { revision: 0, ops: [{ op: "set_name", name: "B" }] });
  offChanged();
  await service.duplicate(created.id);
  await service.delete(created.id);

  assert.deepEqual(changed, [`${created.id}@0`, `${created.id}@1`]);
  assert.deepEqual(deleted, [created.id]);
  assert.ok(published.every((event) => event.channel === WORKFLOWS_CHANNEL));
  assert.deepEqual(
    published.map((event) => event.type),
    ["workflow.upserted", "workflow.upserted", "workflow.upserted", "workflow.deleted"]
  );
  assert.deepEqual(published[1]!.payload, { workflow: { id: created.id, name: "B" } });
  assert.deepEqual(published[3]!.payload, { id: created.id });
});

test("validation context: secret names and saved prompt ids reach validateWorkflow", async () => {
  const dir = await scratch();
  const { service } = makeService(join(dir, "workflows.json"), {
    secretNames: (id) => (id === undefined ? ["GLOBAL"] : ["GLOBAL", `OWN_${id.replace(/-/g, "_").toUpperCase()}`]),
    savedPromptIds: () => ["p1"]
  });
  await service.load();
  const created = (await service.create(request())).workflow;
  const options = service.validationOptions(created.id);
  assert.deepEqual(options.savedPromptIds, ["p1"]);
  assert.deepEqual(options.knownWorkflowIds, [created.id]);
  assert.ok(options.secretNames?.includes("GLOBAL"));
});
