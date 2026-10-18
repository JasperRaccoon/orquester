import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import {
  SESSION_PROFILES_CHANNEL,
  sessionProfileRoutes,
  type SessionProfileDetail,
  type SessionProfileErrorBody,
  type SessionProfileItemDetail,
  type SessionProfileListResponse,
  type SessionProfileMutationResponse,
  type SessionProfilePrepareStatusResponse
} from "@orquester/api";
import { registerSessionProfileRoutes } from "./routes.ts";
import { SessionProfileService, publishSessionProfileEvents } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SECRET = "xoxb-THE-SECRET-VALUE";

async function harness(): Promise<{ app: FastifyInstance; events: { channel: string; type: string; payload: unknown }[] }> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-session-profile-routes-"));
  roots.push(appdir);
  const store = new SessionProfileStore({ appdir });
  const service = new SessionProfileService({ store });
  await service.init();
  const events: { channel: string; type: string; payload: unknown }[] = [];
  publishSessionProfileEvents(service, { publish: (channel, type, payload) => events.push({ channel, type, payload }) });
  const app = Fastify();
  registerSessionProfileRoutes(app, { service });
  await app.ready();
  apps.push(app);
  return { app, events };
}

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
