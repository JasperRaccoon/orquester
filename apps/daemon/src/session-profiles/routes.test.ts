import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import {
  SESSION_PROFILES_CHANNEL,
  sessionProfileRoutes,
  type ImportSessionProfileResponse,
  type ProfileImportScanResponse,
  type SessionProfileDetail,
  type SessionProfileErrorBody,
  type SessionProfileGlobalSourceResponse,
  type SessionProfileImportResponse,
  type SessionProfileItemDetail,
  type SessionProfileListResponse,
  type SessionProfileMutationResponse,
  type SessionProfilePrepareStatusResponse,
  type Workflow
} from "@orquester/api";
import { ProfileImportStore } from "../agent-profile/import.ts";
import { buildZip } from "./files.ts";
import { SessionProfileImports, type SessionProfileGlobalConfig } from "./imports.ts";
import { registerSessionProfileRoutes } from "./routes.ts";
import { SessionProfileService, publishSessionProfileEvents } from "./service.ts";
import { SessionProfileStore } from "./store.ts";
import { WorkflowReferenceIndex } from "../workflows/reference-index.ts";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SECRET = "xoxb-THE-SECRET-VALUE";

async function harness(
  options: { workflowReferences?: () => Pick<WorkflowReferenceIndex, "profileUses"> | null } = {}
): Promise<{ app: FastifyInstance; events: { channel: string; type: string; payload: unknown }[] }> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-session-profile-routes-"));
  roots.push(appdir);
  const store = new SessionProfileStore({ appdir });
  const service = new SessionProfileService({ store });
  await service.init();
  const events: { channel: string; type: string; payload: unknown }[] = [];
  publishSessionProfileEvents(service, { publish: (channel, type, payload) => events.push({ channel, type, payload }) });
  const app = Fastify();
  registerSessionProfileRoutes(app, { service, importsDir: join(appdir, "imports"), ...options });
  await app.ready();
  apps.push(app);
  return { app, events };
}

/** A stored workflow whose agent block launches with `profileId`. */
function usingWorkflow(id: string, profileId: string): Workflow {
  const STAMP = "2026-10-18T00:00:00.000Z";
  return {
    id, name: `WF ${id}`, enabled: true, revision: 1, project: { kind: "existing", projectPath: "/w/acme/api" },
    settings: { overlap: "skip", maxConcurrent: 2, timezone: "UTC", notify: { onFailure: true, onSuccess: false }, keepFailedTempDays: 3 },
    nodes: [{ id: "a", name: "Fix", type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "text", text: "x" }, chain: [{ agent: "claude", model: "default" }], profileId } }],
    edges: [], createdAt: STAMP, updatedAt: STAMP
  } as unknown as Workflow;
}

describe("session profile delete guard (spec §5.5, the saved-prompt expectWorkflowUses pattern)", () => {
  async function withProfile(index: WorkflowReferenceIndex | null) {
    const { app } = await harness({ workflowReferences: () => index });
    const created = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Ops" } })).json() as SessionProfileDetail;
    const del = (expect?: string) =>
      app.inject({ method: "DELETE", url: `${sessionProfileRoutes.profile(created.id)}?revision=${created.revision}${expect === undefined ? "" : `&expectWorkflowUses=${expect}`}` });
    const exists = async () => (await app.inject({ method: "GET", url: sessionProfileRoutes.profile(created.id) })).statusCode === 200;
    return { app, profile: created, del, exists };
  }

  it("refuses 409 WORKFLOW_USES_CHANGED, nothing deleted, unless the uses are exactly the ones confirmed; any order", async () => {
    const index = new WorkflowReferenceIndex();
    const h = await withProfile(index);
    index.rebuild({ workflows: [usingWorkflow("wf_1", h.profile.id), usingWorkflow("wf_2", h.profile.id), usingWorkflow("wf_3", "other")] });
    const stale = await h.del("");
    assert.equal(stale.statusCode, 409);
    const body = stale.json() as SessionProfileErrorBody;
    assert.equal(body.error.code, "WORKFLOW_USES_CHANGED");
    assert.match(body.error.message, /"WF wf_1", "WF wf_2"/, "names the workflows that use it now");
    assert.equal((await h.del("wf_1")).statusCode, 409, "one of two is not the set");
    assert.equal(await h.exists(), true, "nothing was deleted");
    assert.equal((await h.del("wf_2,wf_1")).statusCode, 200);
    assert.equal(await h.exists(), false);
  });

  it("an empty expectation deletes an unused profile; without one (an older client) nothing is checked", async () => {
    const index = new WorkflowReferenceIndex();
    index.rebuild({ workflows: [] });
    const unused = await withProfile(index);
    assert.equal((await unused.del("")).statusCode, 200);
    const used = await withProfile(index);
    index.rebuild({ workflows: [usingWorkflow("wf_1", used.profile.id)] });
    assert.equal((await used.del()).statusCode, 200, "no precondition: the delete goes through");
  });

  it("fails closed: unknown uses, or no index, refuse a delete that names the precondition; a malformed one is 400", async () => {
    const unloaded = await withProfile(new WorkflowReferenceIndex());
    const refused = await unloaded.del("");
    assert.equal(refused.statusCode, 409);
    assert.match((refused.json() as SessionProfileErrorBody).error.message, /cannot tell/);
    const noIndex = await withProfile(null);
    assert.equal((await noIndex.del("")).statusCode, 409);
    assert.equal(await noIndex.exists(), true);
    const bad = await noIndex.app.inject({ method: "DELETE", url: `${sessionProfileRoutes.profile(noIndex.profile.id)}?revision=1&expectWorkflowUses=a&expectWorkflowUses=b` });
    assert.equal(bad.statusCode, 400);
  });
});

describe("session profile routes", () => {
  it("runs the CRUD flow and never answers a secret value", async () => {
    const { app, events } = await harness();
    const created = await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Editor", icon: "🎬" } });
    assert.equal(created.statusCode, 201, created.body);
    const profile = created.json() as SessionProfileDetail;
    assert.equal(profile.revision, "1");
    assert.deepEqual(profile.settings.hideBuiltinSkills, { claude: true, codex: true, grok: true, opencode: true });
    assert.equal(profile.preparation.length, 4);
    assert.ok(profile.preparation.every((status) => status.state === "not-prepared"));

    const item = await app.inject({
      method: "POST",
      url: sessionProfileRoutes.items(profile.id),
      payload: {
        revision: "1",
        draft: {
          kind: "mcp",
          agents: "all",
          mcp: { name: "slack", transport: "http", url: "https://mcp.example", headers: [{ key: "Authorization", value: SECRET }] }
        }
      }
    });
    assert.equal(item.statusCode, 201, item.body);
    const { profile: afterItem, itemId } = item.json() as SessionProfileMutationResponse;
    assert.ok(itemId);
    assert.equal(afterItem.revision, "2");
    assert.equal(afterItem.counts.mcp.total, 1);

    const reads = [
      await app.inject({ method: "GET", url: sessionProfileRoutes.list }),
      await app.inject({ method: "GET", url: sessionProfileRoutes.profile(profile.id) }),
      await app.inject({ method: "GET", url: sessionProfileRoutes.item(profile.id, itemId) })
    ];
    for (const res of [item, ...reads]) {
      assert.equal(res.statusCode < 300, true, res.body);
      assert.ok(!res.body.includes(SECRET), "a secret value crossed the wire");
    }
    const detail = reads[2]!.json() as SessionProfileItemDetail;
    assert.ok(detail.kind === "mcp");
    assert.deepEqual(detail.mcp.headers, [{ key: "Authorization", set: true }]);
    assert.equal((reads[0]!.json() as SessionProfileListResponse).profiles[0]!.name, "Editor");

    const toggled = await app.inject({
      method: "POST",
      url: sessionProfileRoutes.itemEnabled(profile.id, itemId),
      payload: { revision: "2", enabled: false }
    });
    assert.equal((toggled.json() as SessionProfileMutationResponse).profile.counts.mcp.enabled, 0);

    const instructions = await app.inject({
      method: "PUT",
      url: sessionProfileRoutes.instructions(profile.id),
      payload: { revision: "3", text: "Edit videos." }
    });
    assert.equal(instructions.statusCode, 200, instructions.body);
    assert.deepEqual((await app.inject({ method: "GET", url: sessionProfileRoutes.instructions(profile.id) })).json(), {
      text: "Edit videos.",
      revision: "4"
    });

    const status = (await app.inject({ method: "GET", url: sessionProfileRoutes.prepareStatus(profile.id) })).json() as SessionProfilePrepareStatusResponse;
    assert.equal(status.revision, "4");

    const copy = await app.inject({ method: "POST", url: sessionProfileRoutes.duplicate(profile.id), payload: {} });
    assert.equal(copy.statusCode, 201, copy.body);
    assert.equal((copy.json() as SessionProfileDetail).name, "Editor copy");
    assert.ok(!copy.body.includes(SECRET));

    const removedItem = await app.inject({ method: "DELETE", url: `${sessionProfileRoutes.item(profile.id, itemId)}?revision=4` });
    assert.equal(removedItem.statusCode, 200, removedItem.body);
    const removed = await app.inject({ method: "DELETE", url: `${sessionProfileRoutes.profile(profile.id)}?revision=5` });
    assert.deepEqual(removed.json(), { profileId: profile.id, deleted: true });

    assert.ok(events.every((event) => event.channel === SESSION_PROFILES_CHANNEL));
    assert.ok(!JSON.stringify(events).includes(SECRET));
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "sessionProfile.changed",
        "sessionProfile.changed",
        "sessionProfile.changed",
        "sessionProfile.changed",
        "sessionProfile.changed",
        "sessionProfile.changed",
        "sessionProfile.deleted"
      ]
    );
  });

  it("answers refusals in the {error: {code, message}} shape", async () => {
    const { app } = await harness();
    const profile = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "P" } })).json() as SessionProfileDetail;
    const cases: [string, InjectOptions, number, string][] = [
      ["stale revision", { method: "PUT", url: sessionProfileRoutes.profile(profile.id), payload: { revision: "0", name: "Q" } }, 409, "PROFILE_CONFLICT"],
      ["missing revision", { method: "PUT", url: sessionProfileRoutes.profile(profile.id), payload: { name: "Q" } }, 400, "INVALID_REQUEST"],
      ["unknown profile", { method: "GET", url: sessionProfileRoutes.profile("nope") }, 404, "PROFILE_NOT_FOUND"],
      ["path-like profile id", { method: "GET", url: sessionProfileRoutes.profile("../../etc") }, 404, "PROFILE_NOT_FOUND"],
      ["unknown item", { method: "GET", url: sessionProfileRoutes.item(profile.id, "nope") }, 404, "ITEM_NOT_FOUND"],
      ["duplicate name", { method: "POST", url: sessionProfileRoutes.list, payload: { name: "p" } }, 409, "PROFILE_NAME_TAKEN"],
      [
        "plugin by hand",
        { method: "POST", url: sessionProfileRoutes.items(profile.id), payload: { revision: "1", draft: { kind: "plugin", agents: ["claude"], plugin: { name: "x" } } } },
        400,
        "KIND_NOT_SUPPORTED"
      ],
      [
        "unknown agent in scope",
        { method: "POST", url: sessionProfileRoutes.items(profile.id), payload: { revision: "1", draft: { kind: "skill", agents: ["cursor"], document: { name: "a", body: "" } } } },
        400,
        "INVALID_REQUEST"
      ],
      [
        "bad skill name",
        { method: "POST", url: sessionProfileRoutes.items(profile.id), payload: { revision: "1", draft: { kind: "skill", document: { name: "Bad Name", frontmatter: { description: "d" }, body: "" } } } },
        400,
        "INVALID_NAME"
      ],
      ["not JSON", { method: "POST", url: sessionProfileRoutes.list, payload: "{nope", headers: { "content-type": "application/json" } }, 400, "INVALID_REQUEST"]
    ];
    for (const [label, request, status, code] of cases) {
      const res = await app.inject(request);
      assert.equal(res.statusCode, status, `${label}: ${res.body}`);
      assert.equal((res.json() as SessionProfileErrorBody).error.code, code, label);
    }
  });

  it("keeps an MCP server's Run in box switch (boxes)", async () => {
    const { app } = await harness();
    const profile = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Box" } })).json() as SessionProfileDetail;
    const create = async (revision: string, name: string, runInBox?: unknown) =>
      app.inject({
        method: "POST",
        url: sessionProfileRoutes.items(profile.id),
        payload: { revision, draft: { kind: "mcp", agents: "all", mcp: { name, transport: "stdio", command: "srv", ...(runInBox !== undefined ? { runInBox } : {}) } } }
      });
    const inBox = await create("1", "inbox", true);
    assert.equal(inBox.statusCode, 201, inBox.body);
    const onHost = await create("2", "onhost");
    assert.equal(onHost.statusCode, 201, onHost.body);
    const detail = async (res: { json(): unknown }) =>
      (await app.inject({ method: "GET", url: sessionProfileRoutes.item(profile.id, (res.json() as SessionProfileMutationResponse).itemId!) })).json() as SessionProfileItemDetail;
    const boxed = await detail(inBox);
    assert.ok(boxed.kind === "mcp");
    assert.equal(boxed.mcp.runInBox, true);
    const hosted = await detail(onHost);
    assert.ok(hosted.kind === "mcp");
    assert.equal(hosted.mcp.runInBox, undefined);
    const bad = await create("3", "bad", "yes");
    assert.equal(bad.statusCode, 400, bad.body);
  });

  it("never quotes a secret value in a refusal", async () => {
    const { app } = await harness();
    const profile = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "P" } })).json() as SessionProfileDetail;
    const res = await app.inject({
      method: "POST",
      url: sessionProfileRoutes.items(profile.id),
      payload: {
        revision: "1",
        draft: { kind: "mcp", mcp: { name: "bad name!", transport: "stdio", command: "x", env: [{ key: "K", value: SECRET }] } }
      }
    });
    assert.equal(res.statusCode, 400);
    assert.ok(!res.body.includes(SECRET));
  });
});

describe("session profile routes — imports, export, import", () => {
  let workDir = "";
  async function importsHarness(): Promise<{ app: FastifyInstance; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "orq-session-profile-import-routes-"));
    roots.push(root);
    const store = new SessionProfileStore({ appdir: root });
    workDir = join(root, "imports");
    const scanner = new ProfileImportStore({ dir: workDir, existing: async () => new Set(), logger: { info: () => undefined, warn: () => undefined } });
    const unused = async (): Promise<never> => {
      throw new Error("not used");
    };
    const global: SessionProfileGlobalConfig = {
      snapshot: async (agent) => ({
        agent,
        installed: true,
        revision: "r",
        instructions: { path: "", exists: true, bytes: 4, lines: 1, revision: "x", warnings: [] },
        items: [
          {
            id: "mcp:tok",
            kind: "mcp",
            name: "tok",
            enabled: true,
            toggleable: true,
            editable: true,
            deletable: true,
            locked: false,
            source: { type: "user", label: "User" },
            revision: "r",
            warnings: []
          }
        ],
        fileErrors: [],
        readAt: "t"
      }),
      readItem: unused,
      readInstructions: async () => ({ text: "Hi.\n", info: { path: "", exists: true, bytes: 4, lines: 1, revision: "x", warnings: [] } }),
      exportItem: async () => ({ kind: "mcp", server: { name: "tok", transport: "http", url: "https://x.example", headers: { Authorization: SECRET } } }),
      pluginSource: unused
    };
    const imports = new SessionProfileImports({ store, global, scanner, workDir });
    const service = new SessionProfileService({ store, imports });
    await service.init();
    const app = Fastify();
    registerSessionProfileRoutes(app, { service, importsDir: workDir });
    await app.ready();
    apps.push(app);
    return { app, root };
  }

  it("imports from Global, streams uploads, exports a zip without secrets and imports it as a new profile", async () => {
    const { app } = await importsHarness();
    const profile = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Routes" } })).json() as SessionProfileDetail;

    const listed = await app.inject({ method: "GET", url: `${sessionProfileRoutes.importGlobal(profile.id)}?agent=claude` });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal((listed.json() as SessionProfileGlobalSourceResponse).items[0]!.id, "mcp:tok");

    const imported = await app.inject({
      method: "POST",
      url: sessionProfileRoutes.importGlobal(profile.id),
      payload: { revision: "1", agent: "claude", itemIds: ["mcp:tok"], instructions: "replace" }
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.ok(!imported.body.includes(SECRET));
    const result = imported.json() as SessionProfileImportResponse;
    assert.equal(result.itemIds.length, 1);
    assert.equal(result.profile.hasInstructions, true);

    const zip = buildZip([{ path: "pack/SKILL.md", data: Buffer.from("---\nname: pack\ndescription: P\n---\n"), mode: 0o644 }]);
    const scan = await app.inject({
      method: "POST",
      url: `${sessionProfileRoutes.importUpload(profile.id)}?name=pack.zip`,
      headers: { "content-type": "application/octet-stream" },
      payload: zip
    });
    assert.equal(scan.statusCode, 200, scan.body);
    assert.deepEqual((await readdir(workDir)).filter((name) => name.startsWith(".orq-upload-")), [], "the upload's temp file is gone");
    const { importId, candidates } = scan.json() as ProfileImportScanResponse;
    const taken = await app.inject({
      method: "POST",
      url: sessionProfileRoutes.importScan(profile.id, importId),
      payload: { revision: "2", picks: candidates.map((candidate) => candidate.ref) }
    });
    assert.equal(taken.statusCode, 200, taken.body);

    const exported = await app.inject({ method: "GET", url: sessionProfileRoutes.exportProfile(profile.id) });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers["content-type"], "application/zip");
    assert.match(String(exported.headers["content-disposition"]), /attachment; filename="routes\.agent-profile\.zip"/);
    assert.ok(!exported.rawPayload.toString("latin1").includes(SECRET));

    const created = await app.inject({
      method: "POST",
      url: `${sessionProfileRoutes.importProfile}?name=routes.agent-profile.zip`,
      headers: { "content-type": "application/octet-stream" },
      payload: exported.rawPayload
    });
    assert.equal(created.statusCode, 201, created.body);
    const answer = created.json() as ImportSessionProfileResponse;
    assert.equal(answer.profile.name, "Routes copy");
    assert.deepEqual(answer.profile.items.map((item) => item.name).sort(), ["pack", "tok"]);
    assert.match(answer.notes.join(" "), /"tok"/);
  });

  it("refuses an upload before reading it, and answers 503 when imports are not wired", async () => {
    const { app } = await importsHarness();
    const cases: [string, InjectOptions, number, string][] = [
      ["json body", { method: "POST", url: `${sessionProfileRoutes.importUpload("nope")}?name=a.zip`, payload: { a: 1 } }, 415, "INVALID_REQUEST"],
      [
        "unknown profile",
        { method: "POST", url: `${sessionProfileRoutes.importUpload("nope")}?name=a.zip`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") },
        404,
        "PROFILE_NOT_FOUND"
      ],
      [
        "path as name",
        { method: "POST", url: `${sessionProfileRoutes.importProfile}?name=../a.zip`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") },
        400,
        "INVALID_REQUEST"
      ],
      [
        "not a zip",
        { method: "POST", url: `${sessionProfileRoutes.importProfile}?name=a.zip`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") },
        400,
        "IMPORT_FAILED"
      ],
      [
        "keep-both plugin",
        { method: "POST", url: sessionProfileRoutes.plugins("p"), payload: { revision: "1", agent: "claude", source: { type: "global", itemId: "x" }, onConflict: "keep-both" } },
        400,
        "INVALID_REQUEST"
      ]
    ];
    for (const [label, request, status, code] of cases) {
      const res = await app.inject(request);
      assert.equal(res.statusCode, status, `${label}: ${res.body}`);
      assert.equal((res.json() as SessionProfileErrorBody).error.code, code, label);
    }
    const { app: bare } = await harness();
    const res = await bare.inject({ method: "GET", url: sessionProfileRoutes.exportProfile("p") });
    assert.equal(res.statusCode, 503);
    assert.equal((res.json() as SessionProfileErrorBody).error.code, "IMPORTS_UNAVAILABLE");
  });
});
