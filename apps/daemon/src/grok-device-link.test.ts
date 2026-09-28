import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrokDeviceLinkStatus } from "@orquester/api";
import { AgentAccountsService } from "./agent-accounts.ts";
import { GrokDeviceLinkService } from "./grok-device-link.ts";

async function setup(t: TestContext, opts: { startStatus?: number; pollStatus?: number; pollBody?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-grok-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accountsDir = join(dir, "accounts");
  const accounts = new AgentAccountsService({
    indexFile: join(dir, "accounts.json"), accountsDir, userhome: dir, now: () => Date.now()
  });
  await accounts.init();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-09-28T12:00:00Z") });
  let starts = 0;
  let tokenRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url) === "https://auth.x.ai/oauth2/device/code") {
      starts += 1;
      return Response.json({
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        user_code: starts === 1 ? "ABCD-EFGH" : "SECOND-CODE",
        device_code: `device-${starts}`, interval: 5, expires_in: 1800
      }, { status: opts.startStatus ?? 200 });
    }
    assert.equal(String(url), "https://auth.x.ai/oauth2/token");
    tokenRequests += 1;
    return Response.json(opts.pollBody ?? {
      access_token: "at-dev", refresh_token: "rt-dev", expires_in: 21600
    }, { status: opts.pollStatus ?? 200 });
  });
  const service = new GrokDeviceLinkService({ importAccount: (content) => accounts.importAccount({ content }) });
  t.after(() => { service.cancel(); });
  return { service, accounts, accountsDir, tokenRequests: () => tokenRequests };
}

async function pollToCompletion(t: TestContext, service: GrokDeviceLinkService): Promise<void> {
  const completed = new Promise<void>((resolve) => {
    const changed = (status: GrokDeviceLinkStatus) => {
      if (status.state !== "idle") return;
      service.events.off("changed", changed);
      resolve();
    };
    service.events.on("changed", changed);
  });
  t.mock.timers.tick(5_000);
  await completed;
}

test("a granted link imports the tokens as a managed grok account", async (t) => {
  const h = await setup(t);
  const started = await h.service.start();
  assert.deepEqual(started, { ok: true, link: {
    url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
    userCode: "ABCD-EFGH", expiresAt: "2026-09-28T12:30:00.000Z"
  } });
  assert.equal(h.service.status().state, "linking");
  await pollToCompletion(t, h.service);
  const [account] = h.accounts.list().accounts;
  assert.equal(account?.agent, "grok");
  const native = JSON.parse(await readFile(join(h.accounts.homePath("grok", account.id), "auth.json"), "utf8"));
  const entry = native["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"];
  assert.equal(entry.key, "at-dev");
  assert.equal(entry.refresh_token, "rt-dev");
  assert.deepEqual(h.service.status(), { state: "idle", link: null, lastError: null });
});

test("a start failure is an upstream result carrying the status, and leaves nothing pending", async (t) => {
  const h = await setup(t, { startStatus: 500 });
  const res = await h.service.start();
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "upstream");
  assert.equal(res.ok === false ? res.status : undefined, 500);
  assert.equal(h.service.status().state, "idle");
});

test("a second start while one is pending is a conflict; cancel drops it locally", async (t) => {
  const h = await setup(t);
  assert.equal((await h.service.start()).ok, true);
  const duplicate = await h.service.start();
  assert.equal(duplicate.ok === false && duplicate.code, "conflict");
  assert.equal(h.service.status().link?.userCode, "ABCD-EFGH");
  assert.equal(h.service.cancel().state, "idle");
  assert.equal(h.service.cancel().state, "idle");
  t.mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.tokenRequests(), 0, "cancelled authorization never reaches the token endpoint");
  assert.deepEqual(h.accounts.list().accounts, []);
});

test("a failed verdict lands on lastError and a fresh attempt clears it", async (t) => {
  const h = await setup(t, { pollStatus: 400, pollBody: { error: "access_denied", error_description: "authorization denied" } });
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.equal(h.service.status().lastError, "authorization denied");
  assert.equal((await h.service.start()).ok, true);
  assert.equal(h.service.status().lastError, null);
});

test("a failed import is reported as the link's error", async (t) => {
  const h = await setup(t);
  await rm(h.accountsDir, { recursive: true });
  await writeFile(h.accountsDir, "a file obstructs account persistence");
  t.mock.method(console, "error", () => undefined);
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.ok(h.service.status().lastError);
  assert.deepEqual(h.accounts.list().accounts, []);
});
