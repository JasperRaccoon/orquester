import assert from "node:assert/strict";
import test from "node:test";
import type { AgentView } from "../../chat-client/index.ts";
import { FakeChatHost } from "./testing/fake-chat-host.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { createValidationCatalog, toValidationCatalog } from "./validation-catalog.ts";

function view(id: string, over: Partial<AgentView> = {}): AgentView {
  return { id, enabled: true, status: "ready", models: [{ slug: "m1", name: "M1", isDefault: true, options: [] }], ...over } as AgentView;
}

test("a provider's models count only once it has been probed; claudex's proxy list whenever it lists any", () => {
  const catalog = toValidationCatalog([
    view("claude"),
    view("codex", { status: "unknown" }),
    view("claudex", { status: "unknown" }),
    view("opencode", { models: [] }),
    view("grok", { enabled: false })
  ]);
  assert.deepEqual(catalog.agents, [
    { id: "claude", enabled: true, models: ["m1"] },
    { id: "codex", enabled: true, models: null },
    { id: "claudex", enabled: true, models: ["m1"] },
    { id: "opencode", enabled: true, models: null },
    { id: "grok", enabled: false, models: ["m1"] }
  ]);
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
