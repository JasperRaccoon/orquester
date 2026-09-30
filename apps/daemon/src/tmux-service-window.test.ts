import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "./tmux.ts";

// The desktop helpers (desktop spec §5.2): listServiceSessions, newServiceWindow,
// listServiceWindows — against a throwaway `-S` server, never the daemon's.

async function makeTestTmux(t: any): Promise<Tmux | null> {
  if (!tmuxAvailable() || !tmuxVersionOk()) {
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), "orq-tmux-win-"));
  const socket = join(dir, "tmux.sock");
  t.after(async () => {
    await new Promise<void>((resolve) => execFile("tmux", ["-S", socket, "kill-server"], () => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return new Tmux(socket);
}

test("service windows: named first window, extra windows, pane pids", async (t) => {
  const tmux = await makeTestTmux(t);
  if (!tmux) return t.skip("no tmux");
  await tmux.newServiceSession({
    name: "orqsvc-desktop-a",
    windowName: "host",
    cwd: "/tmp",
    env: {},
    bin: "sleep",
    args: ["60"]
  });
  await tmux.newServiceWindow({
    session: "orqsvc-desktop-a",
    name: "app-one two",
    cwd: "/tmp",
    env: {},
    bin: "sleep",
    args: ["60"]
  });
  await tmux.newServiceSession({ name: "orqsvc-other", cwd: "/tmp", env: {}, bin: "sleep", args: ["60"] });

  const windows = await tmux.listServiceWindows("orqsvc-desktop-a");
  assert.deepEqual(
    windows.map((w) => w.name),
    ["host", "app-one two"]
  );
  for (const w of windows) {
    assert.ok(Number.isInteger(w.panePid) && w.panePid > 1);
  }
  assert.deepEqual(await tmux.listServiceSessions("orqsvc-desktop-"), ["orqsvc-desktop-a"]);
  assert.deepEqual(await tmux.listServiceWindows("orqsvc-desktop-missing"), []);
});

test("service window helpers keep the orqsvc- guard", async (t) => {
  const tmux = await makeTestTmux(t);
  if (!tmux) return t.skip("no tmux");
  await assert.rejects(() => tmux.listServiceSessions("orq-"));
  await assert.rejects(() => tmux.listServiceWindows("orq-abc"));
  await assert.rejects(() =>
    tmux.newServiceWindow({ session: "orq-abc", name: "x", cwd: "/tmp", env: {}, bin: "sleep", args: ["1"] })
  );
});

test("listServiceSessions is empty when no server runs", async (t) => {
  const tmux = await makeTestTmux(t);
  if (!tmux) return t.skip("no tmux");
  assert.deepEqual(await tmux.listServiceSessions("orqsvc-desktop-"), []);
});
