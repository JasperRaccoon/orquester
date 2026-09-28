import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lock } from "proper-lockfile";
import { AgentProfileError } from "../../errors.ts";
import { ProfileBackups } from "../../infra/index.ts";
import { updateClaudeJsonMcpServers } from "./claude-json.ts";

async function scratch(t: test.TestContext): Promise<{ root: string; file: string; backups: ProfileBackups }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-claude-json-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, ".claude.json"), backups: new ProfileBackups({ dir: join(root, "backups") }) };
}

const LIVE_STATE = {
  numStartups: 41,
  projects: { "/srv/app": { allowedTools: [], hasTrustDialogAccepted: true } },
  mcpServers: { centur: { type: "stdio", command: "/usr/bin/node", args: ["index.js"], env: { CENTUR_PASSWORD: "placeholder" } } },
  oauthAccount: { emailAddress: "owner@example.com" },
  cachedGrowthBookFeatures: { a: 1 }
};

test("a write waits while Claude holds the lock, then lands with every other key as it was", async (t) => {
  const { file, backups } = await scratch(t);
  await writeFile(file, `${JSON.stringify(LIVE_STATE, null, 2)}\n`);
  await chmod(file, 0o600);

  // Claude's own lock: `<file>.lock`, taken the way Claude takes it.
  const releaseHeld = await lock(file, { lockfilePath: `${file}.lock`, realpath: false });

  // Count failed attempts on the lock directory through proper-lockfile's fs seam.
  let refused = 0;
  let onRefused: (() => void) | null = null;
  const refusedTwice = new Promise<void>((resolve) => {
    onRefused = () => {
      refused += 1;
      if (refused === 2) resolve();
    };
  });
  const watchedFs = {
    ...fs,
    mkdir: (path: string, callback: (error: NodeJS.ErrnoException | null) => void) =>
      fs.mkdir(path, (error) => {
        if (error?.code === "EEXIST") onRefused?.();
        callback(error);
      })
  };

  let settled = false;
  const write = updateClaudeJsonMcpServers(
    file,
    (servers) => {
      servers.jira = { type: "stdio", command: "node", args: [], env: {} };
      return "jira";
    },
    { backups, agent: "claude", lockOptions: { fs: watchedFs } }
  ).finally(() => {
    settled = true;
  });

  await refusedTwice;
  assert.equal(settled, false, "the write is still waiting for the lock");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), LIVE_STATE, "nothing written while the lock is held");

  // Claude writes something else while it holds the lock; our write must see it.
  const bumped = { ...LIVE_STATE, numStartups: 42 };
  await writeFile(file, `${JSON.stringify(bumped, null, 2)}\n`);
  await releaseHeld();

  assert.equal(await write, "jira");
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(after), Object.keys(LIVE_STATE), "key order kept");
  assert.equal(after.numStartups, 42, "re-read inside the lock");
  assert.deepEqual(after.projects, LIVE_STATE.projects);
  assert.deepEqual(after.oauthAccount, LIVE_STATE.oauthAccount);
  assert.deepEqual(Object.keys(after.mcpServers), ["centur", "jira"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600, "mode kept");
  assert.equal((await readFile(file, "utf8")).endsWith("}\n"), true, "trailing newline kept");
  await assert.rejects(stat(`${file}.lock`), { code: "ENOENT" }, "lock released");
});

test("an unchanged mutation writes nothing; a throw inside the lock writes nothing and releases", async (t) => {
  const { file, backups } = await scratch(t);
  const text = JSON.stringify(LIVE_STATE);
  await writeFile(file, text);
  await updateClaudeJsonMcpServers(file, () => undefined, { backups, agent: "claude" });
  assert.equal(await readFile(file, "utf8"), text);
  assert.deepEqual(await backups.list("claude"), []);

  await assert.rejects(
    updateClaudeJsonMcpServers(
      file,
      () => {
        throw new Error("conflict found on the fresh copy");
      },
      { backups, agent: "claude" }
    ),
    /conflict found/
  );
  assert.equal(await readFile(file, "utf8"), text);
  await assert.rejects(stat(`${file}.lock`), { code: "ENOENT" });
});

test("a file that does not parse is refused, never overwritten", async (t) => {
  const { file, backups } = await scratch(t);
  await writeFile(file, "{ not json");
  await assert.rejects(
    updateClaudeJsonMcpServers(file, (servers) => ((servers.x = { command: "x" }), undefined), { backups, agent: "claude" }),
    (error) => error instanceof AgentProfileError && error.code === "CONFIG_UNREADABLE"
  );
  assert.equal(await readFile(file, "utf8"), "{ not json");
});

test("a missing file is created 0600 holding only mcpServers", async (t) => {
  const { file, backups } = await scratch(t);
  await updateClaudeJsonMcpServers(file, (servers) => ((servers.a = { command: "a" }), undefined), { backups, agent: "claude" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { mcpServers: { a: { command: "a" } } });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
