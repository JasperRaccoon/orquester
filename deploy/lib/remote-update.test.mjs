// Runs deploy/lib/remote-update.sh against a throwaway checkout: a real git repository with a
// local bare origin, and PATH stubs for pnpm, systemctl, curl and chown (plus NODE_BIN for the
// native-module guard). Each commit carries a HEALTH file ("ok" or "fail"); the systemctl stub's
// restart "runs" whatever the tree holds then, and the curl stub answers /health from it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "remote-update.sh");

const STUBS = {
  pnpm: `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_DIR/calls"
if [ "$1" = "install" ] && [ -f "$STUB_DIR/fail-install" ]; then exit 1; fi
exit 0
`,
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_DIR/calls"
case "$1" in
  restart) cp "$REPO_DIR/HEALTH" "$STUB_DIR/running"; git -C "$REPO_DIR" rev-parse HEAD >> "$STUB_DIR/restarts" ;;
  is-active) if [ "$(cat "$STUB_DIR/running" 2>/dev/null)" = "ok" ] && [ ! -f "$STUB_DIR/all-unhealthy" ]; then echo active; else echo failed; exit 3; fi ;;
esac
`,
  curl: `#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
case "$last" in
  */health)
    echo "curl health" >> "$STUB_DIR/calls"
    if [ "$(cat "$STUB_DIR/running" 2>/dev/null)" = "ok" ] && [ ! -f "$STUB_DIR/all-unhealthy" ]; then printf '{"ok":true}'; exit 0; fi
    echo "curl: (7) Failed to connect" >&2; exit 7 ;;
  *) echo '<script type="module" src="/assets/index-AbC123.js"></script>' ;;
esac
`,
  chown: `#!/usr/bin/env bash
exit 0
`,
  node: `#!/usr/bin/env bash
if [ "$1" = "-v" ]; then echo v24.0.0; exit 0; fi
echo "node $*" >> "$STUB_DIR/calls"
exit 0
`
};

let root = "";
let origin = "";
let repo = "";
let stubs = "";
let work = "";

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null"
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commit a release whose daemon is healthy or not (plus `files`), push it to origin main; returns its sha. */
function release(health, version, files = {}) {
  writeFileSync(join(work, "HEALTH"), `${health}\n`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  writeFileSync(join(work, "package.json"), `{\n  "name": "orquester",\n  "version": "${version}"\n}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", `${version} (${health})`);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

function deploy(env = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...gitEnv,
      PATH: `${join(stubs, "bin")}:${process.env.PATH}`,
      STUB_DIR: stubs,
      REPO_DIR: repo,
      NODE_BIN: join(stubs, "bin", "node"),
      HEALTH_WAIT: "1",
      SUDO: "",
      ...env
    }
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const head = () => git(repo, "rev-parse", "HEAD");
const lastDeployed = () => readFileSync(join(repo, ".git", "orq-last-deployed-head"), "utf8").trim();
const stamp = () => JSON.parse(readFileSync(join(repo, ".orquester-version.json"), "utf8"));
const restarts = () => (existsSync(join(stubs, "restarts")) ? readFileSync(join(stubs, "restarts"), "utf8").trim().split("\n") : []);

let good = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orq-remote-update-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  repo = join(root, "opt-orquester");
  stubs = join(root, "stubs");
  mkdirSync(join(stubs, "bin"), { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, "bin", name), body);
    chmodSync(join(stubs, "bin", name), 0o755);
  }
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  good = release("ok", "1.0.0");
  git(root, "clone", "-q", "-b", "main", origin, repo);
  // The release running now, deployed successfully earlier.
  writeFileSync(join(repo, ".git", "orq-last-deployed-head"), `${good}\n`);
  writeFileSync(join(stubs, "running"), "ok\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a healthy release deploys, records itself and prints its version and commit", () => {
  const next = release("ok", "1.1.0");
  const result = deploy();
  assert.equal(result.code, 0, result.err);
  assert.equal(head(), next);
  assert.equal(lastDeployed(), next);
  assert.deepEqual(restarts(), [next]);
  assert.match(result.out, new RegExp(`version=1\\.1\\.0 commit=${next}`));
  assert.match(result.out, /bundle=index-AbC123\.js/);
  assert.equal(stamp().commit, next);
  assert.equal(stamp().version, "1.1.0");
});

test("an unhealthy release is rolled back to the previous one, which is restarted and healthy; the deploy fails", () => {
  const bad = release("fail", "2.0.0");
  const result = deploy();
  assert.equal(result.code, 3, result.out + result.err);
  assert.equal(head(), good, "the tree is back on the previous release");
  assert.equal(lastDeployed(), good, "the failed release is never recorded as deployed");
  assert.deepEqual(restarts(), [bad, good], "the previous release was restarted");
  assert.equal(readFileSync(join(stubs, "running"), "utf8").trim(), "ok");
  assert.equal(stamp().commit, good);
  assert.match(result.out, new RegExp(`version=1\\.0\\.0 commit=${good}`));
  const calls = readFileSync(join(stubs, "calls"), "utf8");
  assert.equal(calls.split("\n").filter((line) => line.startsWith("pnpm install")).length, 2, "the previous release is rebuilt");
});

test("when the previous release does not come back either, the deploy fails loudly with its own code", () => {
  release("fail", "2.0.0");
  writeFileSync(join(stubs, "all-unhealthy"), "");
  const result = deploy();
  assert.equal(result.code, 4, result.out + result.err);
  assert.equal(lastDeployed(), good);
});

test("AUTO_REVERT=0 leaves the unhealthy release in place and fails", () => {
  const bad = release("fail", "2.0.0");
  const result = deploy({ AUTO_REVERT: "0" });
  assert.equal(result.code, 1);
  assert.equal(head(), bad);
  assert.deepEqual(restarts(), [bad]);
});

test("a failed build never restarts the daemon", () => {
  release("ok", "1.1.0");
  writeFileSync(join(stubs, "fail-install"), "");
  const result = deploy();
  assert.equal(result.code, 1);
  assert.deepEqual(restarts(), []);
  assert.equal(lastDeployed(), good);
});

test("an update while another holds the checkout's lock touches nothing and exits 5", { skip: spawnSync("sh", ["-c", "command -v flock"]).status !== 0 && "no flock on this host" }, () => {
  release("ok", "1.1.0");
  const lock = join(repo, ".git", "orq-deploy.lock");
  writeFileSync(lock, "");
  // flock(1) holds the lock while it runs the deploy, which opens the file again and must not get it.
  const held = spawnSync("flock", [lock, "bash", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...gitEnv, PATH: `${join(stubs, "bin")}:${process.env.PATH}`, STUB_DIR: stubs, REPO_DIR: repo, NODE_BIN: join(stubs, "bin", "node"), HEALTH_WAIT: "1", SUDO: "" }
  });
  assert.equal(held.status, 5, held.stderr);
  assert.match(held.stderr, /another update is running/);
  assert.equal(head(), good, "the tree was not reset");
  assert.deepEqual(restarts(), []);

  const result = deploy();
  assert.equal(result.code, 0, result.err);
});

test("the manual rollback to a sha still works, and a later unhealthy deploy reverts to it", () => {
  const second = release("ok", "1.1.0");
  assert.equal(deploy().code, 0);
  assert.equal(lastDeployed(), second);
  const back = deploy({ RESET_REF: good });
  assert.equal(back.code, 0, back.err);
  assert.equal(head(), good);
  assert.equal(lastDeployed(), good);
  assert.equal(stamp().commit, good);
  release("fail", "3.0.0");
  assert.equal(deploy().code, 3);
  assert.equal(head(), good, "reverted to the release the rollback installed");
});

test("an unknown ref fails before touching the tree", () => {
  const result = deploy({ RESET_REF: "0000000000000000000000000000000000000000" });
  assert.equal(result.code, 1);
  assert.equal(head(), good);
  assert.match(result.err, /ref not found/);
  assert.deepEqual(restarts(), []);
});

test("voxl's install is best-effort: its version is reported, and a failure only warns", () => {
  const ok = release("ok", "1.1.0", {
    "deploy/install-voxl.sh": "echo '[install-voxl] voxl 0.3.4 already installed at /opt/orquester-tools/voxl/0.3.4/voxl'\necho '[install-voxl] voxl 0.3.4 at /opt/orquester-tools/voxl/0.3.4/voxl'\n"
  });
  const installed = deploy();
  assert.equal(installed.code, 0, installed.err);
  assert.match(installed.out, /voxl=0\.3\.4$/m);

  const failing = release("ok", "1.2.0", {
    "deploy/install-voxl.sh": "echo '[install-voxl] ERROR: cargo install voxl-server 0.3.4 failed' >&2\nexit 1\n"
  });
  const failed = deploy();
  assert.equal(failed.code, 0, failed.err);
  assert.equal(head(), failing);
  assert.deepEqual(restarts(), [ok, failing], "the daemon is restarted all the same");
  assert.match(failed.out, /voxl=FAILED: cargo install voxl-server 0\.3\.4 failed$/m);
  assert.match(failed.err, /WARNING: voxl not installed/);
});

test("a release without install-voxl.sh skips it", () => {
  release("ok", "1.1.0");
  const result = deploy();
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /voxl=skipped$/m);
});
