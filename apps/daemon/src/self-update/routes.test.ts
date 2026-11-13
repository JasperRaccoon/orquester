import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { selfUpdateRoutes, type SelfUpdateStatusResponse } from "@orquester/api";
import { registerSelfUpdateRoutes } from "./routes.ts";
import { SelfUpdateService } from "./service.ts";

const RUNNING = "a".repeat(40);

async function harness(t: TestContext, options: { canUpdate: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "orq-self-update-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/o/r.git\n');
  const requestPath = join(dir, "appdir", "daemon", "update-request");
  const service = new SelfUpdateService({
    repoRoot: dir,
    commit: RUNNING,
    requestPath,
    statusPath: options.canUpdate ? join(dir, "status.json") : null,
    fetch: (async () => {
      throw new Error("no network in route tests");
    }) as typeof fetch
  });
  const app = Fastify();
  registerSelfUpdateRoutes(app, { service });
  t.after(() => app.close());
  return { app, requestPath };
}

test("GET answers the update status", async (t) => {
  const { app } = await harness(t, { canUpdate: true });
  const response = await app.inject({ method: "GET", url: selfUpdateRoutes.status });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json() as SelfUpdateStatusResponse, {
    current: RUNNING,
    branch: "main",
    repo: "o/r",
    latest: null,
    behindBy: 0,
    checkedAt: null,
    error: null,
    canUpdate: true,
    run: null,
    requestStalled: false
  });
});

test("POST starts one update; a second answers 409 busy", async (t) => {
  const { app, requestPath } = await harness(t, { canUpdate: true });
  const first = await app.inject({ method: "POST", url: selfUpdateRoutes.status });
  assert.equal(first.statusCode, 202, first.body);
  const started = first.json() as { started: boolean; requestedAt: string };
  assert.equal(started.started, true);
  assert.ok(!Number.isNaN(Date.parse(started.requestedAt)), "requestedAt is an ISO time");
  await access(requestPath);

  const second = await app.inject({ method: "POST", url: selfUpdateRoutes.status });
  assert.equal(second.statusCode, 409);
  const body = second.json() as { code: string; message: string; requestedAt: string };
  assert.equal(body.code, "SELF_UPDATE_BUSY");
  assert.equal(typeof body.message, "string");
  assert.ok(!Number.isNaN(Date.parse(body.requestedAt)), "when the pending update began, to follow it");
});

test("POST answers 409 unavailable when the install cannot update itself", async (t) => {
  const { app, requestPath } = await harness(t, { canUpdate: false });
  const response = await app.inject({ method: "POST", url: selfUpdateRoutes.status });
  assert.equal(response.statusCode, 409);
  assert.equal((response.json() as { code: string }).code, "SELF_UPDATE_UNAVAILABLE");
  await assert.rejects(access(requestPath));
});
