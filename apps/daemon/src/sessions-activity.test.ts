import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RegistryEntry } from "@orquester/api";
import type { RegistryService } from "./registry.ts";
import { LocalSessionManager } from "./sessions.ts";

async function waitFor<T>(poll: () => T | undefined | false, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = poll();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

test("LocalSessionManager tracks bell activity and clears attention on input", async () => {
  const root = await mkdtemp(join(tmpdir(), "orquester-session-activity-"));
  const sh: RegistryEntry = {
    id: "sh",
    name: "sh",
    kind: "shell",
    bin: ["/bin/sh"],
    args: ["-c", "printf 'ready\\007'; sleep 30"],
    enabled: true,
    resolvedBin: "/bin/sh",
    installState: "idle",
  };
  const registry = {
    get(id: string) {
      return id === sh.id ? sh : undefined;
    },
  } as Pick<RegistryService, "get"> as RegistryService;
  const mgr = new LocalSessionManager(registry);
  const activityEvents: Array<{ id: string; type: "bell" }> = [];

  mgr.lifecycle.on("activity", (event) => activityEvents.push(event));

  try {
    const session = mgr.create({ kind: "shell", refId: "sh", projectPath: root, cwd: root });

    const activity = await waitFor(() => {
      const snapshot = mgr.activity(session.id);
      return snapshot?.attention ? snapshot : false;
    });

    assert.equal(activity.attention, true);
    assert.equal(typeof activity.lastOutputAt, "number");
    assert.deepEqual(activityEvents, [{ id: session.id, type: "bell" }]);

    mgr.input(session.id, " ");
    assert.equal(mgr.activity(session.id)?.attention, false);
    assert.equal(mgr.activity("missing"), undefined);
  } finally {
    mgr.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
