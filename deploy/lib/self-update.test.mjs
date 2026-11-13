// Runs deploy/lib/self-update.sh (the wrapper orquester-update.service runs) against a throwaway
// git repository, with a stub UPDATE_SCRIPT in place of remote-update.sh: the stub records the
// status file as it is while the update runs, then exits with $STUB_EXIT.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "self-update.sh");

const STUB = `#!/usr/bin/env bash
cp "$STATUS_FILE" "$STUB_DIR/during.json"
printf '%s %s\\n' "$REPO_DIR" "$BRANCH" > "$STUB_DIR/args"
# systemd stopping the unit signals the whole cgroup, the wrapper included.
if [ -n "\${STUB_TERM_WRAPPER:-}" ]; then kill -TERM "$PPID"; fi
exit "$STUB_EXIT"
`;

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null"
};

let root = "";
let repo = "";
let stubs = "";
let requestFile = "";
let statusFile = "";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function update(env = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...gitEnv,
      STUB_DIR: stubs,
      STUB_EXIT: "0",
      REQUEST_FILE: requestFile,
      STATUS_FILE: statusFile,
      UPDATE_SCRIPT: join(stubs, "remote-update.sh"),
      REPO_DIR: repo,
      ...env
    }
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orq-self-update-"));
  repo = join(root, "opt-orquester");
  stubs = join(root, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "remote-update.sh"), STUB);
  chmodSync(join(stubs, "remote-update.sh"), 0o755);
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "release");
  mkdirSync(join(root, "appdir", "daemon"), { recursive: true });
  requestFile = join(root, "appdir", "daemon", "update-request");
  writeFileSync(requestFile, "");
  // The unit's StateDirectory; the wrapper creates it when it is missing.
  statusFile = join(root, "state", "orquester-update", "status.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

for (const [exit, state] of [
  [0, "succeeded"],
  [3, "reverted"],
  [1, "failed"]
]) {
  test(`an update that exits ${exit} is recorded as ${state}, and the request is consumed`, () => {
    const head = git(repo, "rev-parse", "HEAD");
    const result = update({ STUB_EXIT: String(exit) });
    assert.equal(result.code, exit, result.out + result.err);
    assert.equal(existsSync(requestFile), false, "the request file is gone, so the path unit does not loop");

    const during = readJson(join(stubs, "during.json"));
    assert.equal(during.state, "running");
    assert.equal(during.from, head);
    assert.match(during.startedAt, ISO);
    assert.equal("finishedAt" in during, false);
    assert.equal("exitCode" in during, false);

    const final = readJson(statusFile);
    assert.equal(final.state, state);
    assert.equal(final.from, head);
    assert.equal(final.startedAt, during.startedAt);
    assert.match(final.finishedAt, ISO);
    assert.equal(final.exitCode, exit);
    assert.equal(readFileSync(join(stubs, "args"), "utf8").trim(), `${repo} main`);
  });
}

test("a repository it cannot read records from as null and still runs the update", () => {
  const result = update({ REPO_DIR: join(root, "not-a-repo") });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(readJson(join(stubs, "during.json")).from, null);
  const final = readJson(statusFile);
  assert.equal(final.from, null);
  assert.equal(final.state, "succeeded");
  assert.equal(existsSync(requestFile), false);
});

test("a wrapper stopped mid-run records failed rather than staying running", () => {
  const result = update({ STUB_TERM_WRAPPER: "1" });
  assert.equal(result.code, 143, result.out + result.err);
  assert.equal(readJson(join(stubs, "during.json")).state, "running");
  const final = readJson(statusFile);
  assert.equal(final.state, "failed");
  assert.equal(final.exitCode, 143);
  assert.match(final.finishedAt, ISO);
  assert.equal(existsSync(requestFile), false);
});
