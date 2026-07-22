import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tmux, tmuxAvailable, tmuxVersionOk, SERVICE_SESSION_PREFIX } from "./tmux.ts";

/**
 * Build a Tmux against a throwaway `-S` socket (never the daemon's). Returns null
 * when tmux is unavailable/too old so the caller can t.skip(). Registers cleanup
 * that kills the dedicated server and removes its dir.
 */
async function makeTestTmux(t: any): Promise<Tmux | null> {
  if (!tmuxAvailable() || !tmuxVersionOk()) {
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), "orq-tmux-svc-"));
  const socket = join(dir, "tmux.sock");
  t.after(async () => {
    await new Promise<void>((resolve) =>
      execFile("tmux", ["-S", socket, "kill-server"], () => resolve())
    );
    await rm(dir, { recursive: true, force: true });
  });
  return new Tmux(socket);
}

test("SERVICE_SESSION_PREFIX is outside the reaped orq- namespace", () => {
  assert.equal(SERVICE_SESSION_PREFIX, "orqsvc-");
  assert.equal("orqsvc-cliproxy".startsWith("orq-"), false);
});

test("service session lives outside orq- namespace and survives listSessions/reattach scans", async (t) => {
  const tmux = await makeTestTmux(t);
  if (!tmux) return t.skip("no tmux");
  await tmux.newServiceSession({ name: "orqsvc-test", cwd: "/tmp", env: {}, bin: "sleep", args: ["60"] });
  assert.equal(await tmux.hasServiceSession("orqsvc-test"), true);
  const sessions = await tmux.listSessions();
  assert.ok(
    !sessions.includes("svc-test") && !sessions.some((s) => s.includes("orqsvc")),
    "listSessions (the reaper's input) must not see the service session"
  );
  await tmux.killServiceSession("orqsvc-test");
  assert.equal(await tmux.hasServiceSession("orqsvc-test"), false);
});

test("newServiceSession rejects non-orqsvc names", async (t) => {
  const tmux = await makeTestTmux(t);
  if (!tmux) return t.skip("no tmux");
  await assert.rejects(() =>
    tmux.newServiceSession({ name: "orq-evil", cwd: "/tmp", env: {}, bin: "sleep", args: ["1"] })
  );
  await assert.rejects(() =>
    tmux.newServiceSession({ name: "random", cwd: "/tmp", env: {}, bin: "sleep", args: ["1"] })
  );
});
