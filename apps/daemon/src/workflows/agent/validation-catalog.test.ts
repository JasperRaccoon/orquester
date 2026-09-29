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
