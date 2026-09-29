// The rail's problem chip follows the agent catalogue: a registry or provider change on the bus
// re-reads the catalogue at once and re-publishes a row whose errors changed — through the REAL
// wiring (`createWorkflowDaemon`) and routes, with the `FakeChatHost` as the daemon's own client.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { EventMessage, WorkflowSummary, WorkflowWriteResponse } from "@orquester/api";

import { DEFAULT_FAKE_AGENTS, FakeChatHost } from "./agent/testing/fake-chat-host.ts";
import { FakeClock } from "./agent/testing/fake-clock.ts";
import { boot, tempAppdir } from "./testing/daemon-harness.ts";

const dirs: Awaited<ReturnType<typeof tempAppdir>>[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => dir.cleanup()));
});

test("a provider change re-judges the rows: the problem goes out, and comes back, without an edit", async () => {
  const dir = await tempAppdir();
  dirs.push(dir);
  const host = new FakeChatHost({ clock: new FakeClock("2026-09-29T12:00:00.000Z") });
  // The host's own bus for registry events (the fake host only speaks for sessions).
  const registryBus = new Set<(event: EventMessage) => void>();
  const api: DaemonApi = {
    request: (method, path, opts) => host.request(method, path, opts),
    uploadAttachment: () => host.uploadAttachment(),
    subscribe: (listener) => {
      const off = host.subscribe(listener);
      registryBus.add(listener);
      return () => {
        off();
        registryBus.delete(listener);
      };
    },
    fsRoot: host.fsRoot,
    workspacesDir: host.workspacesDir
  };
  let seq = 0;
  const providersChanged = (): void => {
    const event: EventMessage = { id: `r${++seq}`, channel: "registry", type: "agent.providers.changed", createdAt: "2026-09-29T12:00:00.000Z", payload: {} };
    for (const listener of [...registryBus]) listener(event);
  };

  const h = await boot(dir.root, { engineApi: () => api });
  try {
    const created = await h.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        name: "Nightly",
        project: { kind: "existing", projectPath: join(dir.workspacesDir, "acme", "app") },
        nodes: [
          { type: "trigger.manual", name: "Start", config: {} },
          { type: "agent", name: "NightlyTask", config: { prompt: { kind: "text", text: "Tidy" }, chain: [{ agent: "claude", model: "opus[1m]" }] } }
        ],
        edges: [{ source: "Start", target: "NightlyTask" }]
      }
    });
    assert.equal(created.statusCode, 201);
    const id = (JSON.parse(created.body) as WorkflowWriteResponse).workflow.id;
    const rowOf = (event: EventMessage): WorkflowSummary | null =>
      event.channel === "workflows" && event.type === "workflow.upserted" ? ((event.payload as { workflow: WorkflowSummary }).workflow ?? null) : null;

    const listed = JSON.parse((await h.inject({ method: "GET", url: "/api/workflows" })).body) as { workflows: WorkflowSummary[] };
    const row = listed.workflows.find((candidate) => candidate.id === id);
    assert.equal(row?.errorCount, 1);
    assert.equal(row?.errors?.[0]?.code, "unknown_model");
    assert.match(row?.errors?.[0]?.message ?? "", /NightlyTask: claude has no model "opus\[1m\]"/);

    // The provider is probed again and now lists the slug: the row goes out without its problem.
    host.agents = DEFAULT_FAKE_AGENTS.map((agent) =>
      agent.id === "claude" ? { ...agent, models: [...agent.models, { slug: "opus[1m]", name: "Opus (1M)" }] } : agent
    );
    let since = h.events.length;
    providersChanged();
    const fixed = rowOf(await h.waitEvent((event) => rowOf(event)?.id === id && rowOf(event)?.errorCount === 0, 20_000, since));
    assert.equal(fixed && "errors" in fixed, false);

    // And back.
    host.agents = DEFAULT_FAKE_AGENTS;
    since = h.events.length;
    providersChanged();
    const broken = rowOf(await h.waitEvent((event) => rowOf(event)?.id === id && rowOf(event)?.errorCount === 1, 20_000, since));
    assert.equal(broken?.errors?.[0]?.field, "config.chain.0.model");
  } finally {
    await h.close();
  }
});
