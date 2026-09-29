import assert from "node:assert/strict";
import test from "node:test";
import { FakeChatHost } from "./testing/fake-chat-host.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { createValidationCatalog } from "./validation-catalog.ts";

test("a provider's models count only once it has been probed", async () => {
  const host = new FakeChatHost({ clock: new FakeClock() });
  const request = host.request.bind(host);
  host.request = async (method, path, opts) => {
    const response = await request(method, path, opts);
    if (path === "/api/agent/providers") {
      const body = response.body as { providers: { id: string; status: string; models: unknown[] }[] };
      for (const provider of body.providers) {
        if (provider.id === "codex") provider.status = "unknown";
        if (provider.id === "opencode") provider.models = [];
      }
    }
    return response;
  };
  const catalog = createValidationCatalog({ api: () => host });
  await catalog.ready();
  const models = (id: string) => catalog.current()?.agents.find((agent) => agent.id === id)?.models;
  assert.deepEqual(models("claude"), ["opus", "sonnet"]);
  assert.equal(models("codex"), null);
  assert.equal(models("opencode"), null);
});

test("nothing is known before the client is attached; ready() then reads the host's catalogue", async () => {
  const host = new FakeChatHost({ clock: new FakeClock("2026-09-28T12:00:00.000Z") });
  let api: FakeChatHost | null = null;
  const catalog = createValidationCatalog({ api: () => api });
  await catalog.ready();
  assert.equal(catalog.current(), undefined);
  api = host;
  await catalog.ready();
  const read = catalog.current();
  assert.deepEqual(read?.agents.find((agent) => agent.id === "codex"), { id: "codex", enabled: true, models: ["gpt-5"] });
});

test("a degraded or errored provider (a failed probe's fallback list) counts as not loaded", async () => {
  const host = new FakeChatHost({ clock: new FakeClock() });
  const request = host.request.bind(host);
  host.request = async (method, path, opts) => {
    const response = await request(method, path, opts);
    if (path === "/api/agent/providers") {
      const body = response.body as { providers: { id: string; status: string }[] };
      for (const provider of body.providers) {
        if (provider.id === "claude") provider.status = "degraded";
        if (provider.id === "codex") provider.status = "error";
      }
    }
    return response;
  };
  const catalog = createValidationCatalog({ api: () => host });
  await catalog.ready();
  const models = (id: string) => catalog.current()?.agents.find((agent) => agent.id === id)?.models;
  assert.equal(models("claude"), null);
  assert.equal(models("codex"), null);
});

/** An API whose every request is counted, answering from `answer` (or failing). */
function countingApi(answer: (method: string, path: string) => Promise<{ status: number; body: unknown }>) {
  const api = {
    requests: 0,
    request(method: string, path: string) {
      api.requests += 1;
      return answer(method, path);
    }
  };
  return api;
}

test("a failed read is not retried on every request, only once the refresh window has passed", async () => {
  let t = 1_000_000;
  const api = countingApi(async () => ({ status: 500, body: {} }));
  const catalog = createValidationCatalog({ api: () => api as never, now: () => t, ttlMs: 30_000 });
  await catalog.ready();
  const afterFirst = api.requests;
  assert.ok(afterFirst > 0);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(catalog.current(), undefined);
    await catalog.ready();
  }
  assert.equal(api.requests, afterFirst, "no read inside the backoff");
  t += 29_999;
  await catalog.ready();
  assert.equal(api.requests, afterFirst);
  t += 1;
  await catalog.ready();
  assert.equal(api.requests, afterFirst * 2, "one more read once the window has passed");
});

test("expire() reads again at once — even inside a failure's backoff — and keeps the last reading until then", async () => {
  const host = new FakeChatHost({ clock: new FakeClock("2026-09-28T12:00:00.000Z") });
  let failing = false;
  const api = countingApi((method, path) => (failing ? Promise.resolve({ status: 500, body: {} }) : host.request(method as never, path)));
  const t = 1_000_000;
  const catalog = createValidationCatalog({ api: () => api as never, now: () => t, ttlMs: 30_000 });
  await catalog.ready();
  const first = catalog.current();
  assert.ok(first);
  const reads = api.requests;
  // Fresh: no read.
  await catalog.ready();
  assert.equal(api.requests, reads);
  // A failing read after expire keeps the last reading, then backs off.
  failing = true;
  catalog.expire();
  assert.equal(catalog.current(), first, "the last reading answers while the new one is read");
  await catalog.ready();
  assert.equal(catalog.current(), first);
  const failed = api.requests;
  await catalog.ready();
  assert.equal(api.requests, failed, "backing off");
  // A change: read again at once.
  failing = false;
  catalog.expire();
  await catalog.ready();
  assert.ok(api.requests > failed);
  assert.deepEqual(catalog.current(), first);
});
