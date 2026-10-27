// SessionManager.settleResize against a real tmux server on a throwaway `-S`
// socket: the resize resync on /ws snapshots only after this resolves, so it
// must resolve exactly when tmux has the new size — with an idle program that
// prints nothing, and without a timer.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import type { RegistryEntry } from "@orquester/api";

import type { RegistryService } from "./registry.ts";
import { drainSessionIndexWrites, SessionManager } from "./sessions.ts";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "./tmux.ts";

const run = promisify(execFile);

const IDLE: RegistryEntry = {
  id: "idle",
  name: "idle",
  kind: "shell",
  bin: ["/bin/sh"],
  args: ["-c", "sleep 600"],
  enabled: true,
  resolvedBin: "/bin/sh",
  installState: "idle"
};
const registry = { get: (id: string) => (id === IDLE.id ? IDLE : undefined) } as RegistryService;

describe("settleResize on the tmux backend", { skip: tmuxAvailable() && tmuxVersionOk() ? false : "tmux >= 3.2 unavailable" }, () => {
  let root = "";
  let socket = "";
  let manager: SessionManager;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "orq-resize-settle-"));
    socket = join(root, "tmux.sock");
    manager = new SessionManager(registry, new Tmux(socket), join(root, "sessions.json"));
  });

  after(async () => {
    manager.closeAll();
    await drainSessionIndexWrites();
    await new Promise<void>((resolve) => execFile("tmux", ["-S", socket, "kill-server"], () => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const windowSize = async (id: string) =>
    (await run("tmux", ["-S", socket, "display-message", "-p", "-t", `orq-${id}`, "#{window_width}x#{client_height}"])).stdout.trim();

  test("resolves once tmux has applied the size, for a program that prints nothing", async () => {
    const session = await manager.create({ kind: "shell", refId: "idle", projectPath: root, cwd: root, cols: 80, rows: 24 });
    manager.resize(session.id, 123, 37);
    await manager.settleResize(session.id, AbortSignal.timeout(20_000));
    const sizes = await new Tmux(socket).clientSizes(session.id);
    assert.ok(
      sizes.some((size) => size.cols === 123 && size.rows === 37),
      `client sizes ${JSON.stringify(sizes)}`
    );
    assert.match(await windowSize(session.id), /^123x/);
  });

  test("resolves at once when no resize is outstanding", async () => {
    const session = await manager.create({ kind: "shell", refId: "idle", projectPath: root, cwd: root, cols: 80, rows: 24 });
    manager.resize(session.id, 100, 30);
    await manager.settleResize(session.id, AbortSignal.timeout(20_000));
    // The same size again changes nothing, so there is nothing to wait for.
    manager.resize(session.id, 100, 30);
    let settled = false;
    const settling = manager.settleResize(session.id).then(() => { settled = true; }, () => undefined);
    await Promise.resolve();
    assert.equal(settled, true, "an unchanged size resolves without another backend read");
    await settling;
  });

  test("resolves on abort and for an unknown session", async () => {
    await manager.settleResize("nope");
    const session = await manager.create({ kind: "shell", refId: "idle", projectPath: root, cwd: root, cols: 80, rows: 24 });
    const abort = new AbortController();
    abort.abort();
    manager.resize(session.id, 90, 20);
    let settled = false;
    const settling = manager.settleResize(session.id, abort.signal).then(() => { settled = true; }, () => undefined);
    await Promise.resolve();
    assert.equal(settled, true, "an already-cancelled wait resolves without backend I/O");
    await settling;
  });
});
