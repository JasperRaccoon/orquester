import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryEntry } from "@orquester/api";
import type { RegistryService } from "./registry.ts";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "./tmux.ts";
import { LocalSessionManager, SessionManager, type ResolveSessionExtraEnv } from "./sessions.ts";

const claudex: RegistryEntry = {
  id: "claudex",
  name: "claudex",
  kind: "agent",
  bin: ["/bin/sh"],
  args: ["-c", "sleep 30"],
  enabled: true,
  resolvedBin: "/bin/sh",
  installState: "idle"
};

const registry = {
  get(id: string) {
    return id === claudex.id ? claudex : undefined;
  }
} as Pick<RegistryService, "get"> as RegistryService;

test("resolver receives ctx with model; summary carries it", async () => {
  const seen: Array<{ accountId?: string; model?: string }> = [];
  const resolveExtraEnv: ResolveSessionExtraEnv = (_entry, ctx) => {
    seen.push(ctx);
    return null;
  };
  const mgr = new LocalSessionManager(registry, { resolveExtraEnv });
  try {
    const s = await mgr.create({
      kind: "agent",
      refId: "claudex",
      projectPath: "/p",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      model: "kimi-k3"
    });
    assert.equal(seen[0].model, "kimi-k3");
    assert.equal(s.model, "kimi-k3");
  } finally {
    mgr.closeAll();
  }
});

test("model omitted → ctx.model undefined (route-level default resolution is upstream)", async () => {
  const seen: Array<{ accountId?: string; model?: string }> = [];
  const resolveExtraEnv: ResolveSessionExtraEnv = (_entry, ctx) => {
    seen.push(ctx);
    return null;
  };
  const mgr = new LocalSessionManager(registry, { resolveExtraEnv });
  try {
    const s = await mgr.create({
      kind: "agent",
      refId: "claudex",
      projectPath: "/p",
      cwd: "/tmp",
      cols: 80,
      rows: 24
    });
    assert.equal(seen[0].model, undefined);
    assert.equal(s.model, undefined);
  } finally {
    mgr.closeAll();
  }
});

test("effective model persists on the reattach record", async (t) => {
  if (!tmuxAvailable() || !tmuxVersionOk()) return t.skip("no tmux");
  const dir = await mkdtemp(join(tmpdir(), "orq-session-model-"));
  const socket = join(dir, "tmux.sock");
  const indexPath = join(dir, "sessions.json");
  const tmux = new Tmux(socket);
  const mgr = new SessionManager(registry, tmux, indexPath, {
    resolveExtraEnv: () => null
  });
  t.after(async () => {
    mgr.closeAll();
    await new Promise<void>((resolve) =>
      execFile("tmux", ["-S", socket, "kill-server"], () => resolve())
    );
    await rm(dir, { recursive: true, force: true });
  });

  const s = await mgr.create({
    kind: "agent",
    refId: "claudex",
    projectPath: "/p",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    model: "kimi-k3"
  });
  assert.equal(s.model, "kimi-k3");

  // persistIndex() is fire-and-forget at the end of create(); poll for it.
  let record: { id: string; model?: string } | undefined;
  for (let i = 0; i < 80 && !record; i++) {
    try {
      const raw = JSON.parse(await readFile(indexPath, "utf8")) as {
        sessions: Array<{ id: string; model?: string }>;
      };
      record = raw.sessions.find((r) => r.id === s.id);
    } catch {
      /* not written yet */
    }
    if (!record) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(record, "expected the session to be persisted");
  assert.equal(record.model, "kimi-k3");
});
