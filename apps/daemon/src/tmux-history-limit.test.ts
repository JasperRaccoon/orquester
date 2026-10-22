import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TERMINAL_SCROLLBACK_LINES } from "@orquester/api";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "./tmux.ts";

const run = promisify(execFile);

test("new sessions keep the client's scrollback in history; existing panes keep theirs", async (t) => {
  if (!tmuxAvailable() || !tmuxVersionOk()) return t.skip("no tmux");
  const dir = await mkdtemp(join(tmpdir(), "orq-tmux-history-"));
  const socket = join(dir, "tmux.sock");
  t.after(async () => {
    await new Promise<void>((resolve) => execFile("tmux", ["-S", socket, "kill-server"], () => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const limit = async (name: string) =>
    (await run("tmux", ["-S", socket, "display-message", "-p", "-t", name, "#{history_limit}"])).stdout.trim();

  // A pane an older daemon created, under tmux's default limit (`-f /dev/null`: no user config).
  await run("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "orq-old", "--", "sleep", "60"]);
  const before = await limit("orq-old");

  const tmux = new Tmux(socket);
  await tmux.newSession({ id: "new", cols: 80, rows: 24, cwd: dir, env: {}, bin: "sleep", args: ["60"] });

  assert.equal(await limit("orq-new"), String(TERMINAL_SCROLLBACK_LINES));
  assert.equal(await limit("orq-old"), before, "an existing pane's history is untouched");
  assert.equal(await tmux.hasSession("old"), true);
});
