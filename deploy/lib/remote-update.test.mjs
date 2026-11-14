// Runs deploy/lib/remote-update.sh against a throwaway host: a real git repository with a local bare
// origin, a plain checkout at REPO_DIR as installs from before releases have it (the first deploy
// converts it), releases under RELEASES_DIR, and PATH stubs for pnpm, systemctl, curl and chown
// (plus NODE_BIN for the native-module guard). Each commit carries a HEALTH file ("ok" or "fail");
// the systemctl stub's restart "runs" whatever REPO_DIR points at then, and the curl stub answers
// /health from it. PROC_ROOT is a fake /proc the test fills in when a process should use a release.
// Every commit carries this remote-update.sh (it is layout-aware) unless it says otherwise; the one
// the plain checkout runs predates releases, as on a real host.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "remote-update.sh");
const OURS = readFileSync(SCRIPT, "utf8");
const HAS_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const PRE_LAYOUT_SCRIPT = "#!/usr/bin/env bash\n# a remote-update.sh from before releases (no layout marker)\nexit 0\n";

const STUBS = {
  pnpm: `#!/usr/bin/env bash
echo "pnpm $* cwd=$PWD live=$(readlink -f "$REPO_DIR")" >> "$STUB_DIR/calls"
if [ "$1" = "install" ] && [ -f "$STUB_DIR/fail-install" ]; then exit 1; fi
exit 0
`,
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_DIR/calls"
case "$1" in
  restart) cp "$REPO_DIR/HEALTH" "$STUB_DIR/running"; git -C "$REPO_DIR" rev-parse HEAD >> "$STUB_DIR/restarts" ;;
  is-active) if [ "$(cat "$STUB_DIR/running" 2>/dev/null)" = "ok" ] && [ ! -f "$STUB_DIR/all-unhealthy" ]; then echo active; else echo failed; exit 3; fi ;;
  is-failed) exit 1 ;;
  show)
    # NRestarts: a daemon that will not come up is restarted by the unit (Restart=always) — one more
    # automatic restart each time the update looks, unless the test says it only hangs.
    n="$(cat "$STUB_DIR/nrestarts" 2>/dev/null || echo 0)"
    if { [ "$(cat "$STUB_DIR/running" 2>/dev/null)" != "ok" ] || [ -f "$STUB_DIR/all-unhealthy" ]; } && [ ! -f "$STUB_DIR/hangs" ]; then
      n=$((n + 1)); echo "$n" > "$STUB_DIR/nrestarts"
    fi
    echo "$n" ;;
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
`,
  // For SUDO=sudo runs: like sudo's env_reset, the command gets a fresh environment — only what the
  // other stubs and git need on this fake host survives.
  "fake-sudo": `#!/usr/bin/env bash
exec env -i PATH="$PATH" HOME="$HOME" STUB_DIR="$STUB_DIR" REPO_DIR="$REPO_DIR" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "$@"
`
};

let root = "";
let origin = "";
let repo = "";
let releases = "";
let previous = "";
let proc = "";
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
  for (const [path, body] of Object.entries({ "deploy/lib/remote-update.sh": OURS, ...files })) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  writeFileSync(join(work, "package.json"), `{\n  "name": "orquester",\n  "version": "${version}"\n}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", `${version} (${health})`);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

function hostEnv(env = {}) {
  return {
    ...process.env,
    ...gitEnv,
    PATH: `${join(stubs, "bin")}:${process.env.PATH}`,
    STUB_DIR: stubs,
    REPO_DIR: repo,
    RELEASES_DIR: releases,
    PREVIOUS_LINK: previous,
    PROC_ROOT: proc,
    RELEASE_MIN_FREE_MB: "0",
    NODE_BIN: join(stubs, "bin", "node"),
    HEALTH_WAIT: "1",
    SUDO: "",
    ...env
  };
}

function deploy(env = {}) {
  const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: hostEnv(env) });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const head = () => git(repo, "rev-parse", "HEAD");
const dirOf = (sha) => join(releases, sha.slice(0, 12));
const live = () => readlinkSync(repo);
const sharedGit = () => join(releases, "repo.git");
const lastDeployed = () => readFileSync(join(sharedGit(), "orq-last-deployed-head"), "utf8").trim();
const stamp = () => JSON.parse(readFileSync(join(repo, ".orquester-version.json"), "utf8"));
const lines = (file) => (existsSync(join(stubs, file)) ? readFileSync(join(stubs, file), "utf8").trim().split("\n").filter(Boolean) : []);
const restarts = () => lines("restarts");
const calls = () => lines("calls");
const installs = () => calls().filter((line) => line.startsWith("pnpm install"));
const marker = (dir) => readFileSync(join(dir, ".orq-release-complete"), "utf8").trim();
const isPlainCheckout = () => !lstatSync(repo).isSymbolicLink() && lstatSync(join(repo, ".git")).isDirectory();

/** The release at `dir` is a complete linked worktree of the shared git dir at `sha`, nothing left of a conversion. */
function assertRelease(dir, sha) {
  assert.ok(lstatSync(join(dir, ".git")).isFile(), `${dir}/.git is a link to the shared git dir`);
  assert.equal(git(dir, "rev-parse", "HEAD"), sha);
  assert.equal(realpathSync(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")), sharedGit());
  assert.equal(marker(dir), sha);
  assert.ok(!existsSync(join(dir, ".git-pre-layout")));
}

let good = "";

function setUpHost() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "orq-remote-update-")));
  origin = join(root, "origin.git");
  work = join(root, "work");
  repo = join(root, "opt-orquester");
  releases = join(root, "opt-orquester-releases");
  previous = join(root, "opt-orquester-previous");
  proc = join(root, "proc");
  stubs = join(root, "stubs");
  mkdirSync(proc);
  mkdirSync(join(stubs, "bin"), { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, "bin", name), body);
    chmodSync(join(stubs, "bin", name), 0o755);
  }
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  good = release("ok", "1.0.0", { "deploy/lib/remote-update.sh": PRE_LAYOUT_SCRIPT });
  // The release running now, deployed successfully earlier into a plain checkout.
  git(root, "clone", "-q", "-b", "main", origin, repo);
  writeFileSync(join(repo, ".git", "orq-last-deployed-head"), `${good}\n`);
  writeFileSync(join(repo, ".orquester-version.json"), `{"commit":"${good}","version":"1.0.0","deployedAt":"2026-11-01T00:00:00Z"}\n`);
  writeFileSync(join(stubs, "running"), "ok\n");
}

beforeEach(setUpHost);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a plain checkout becomes the release it runs, and each release is built in its own directory before the link moves to it", () => {
  const next = release("ok", "1.1.0");
  const first = deploy();
  assert.equal(first.code, 0, first.out + first.err);
  // The build ran in the new release while REPO_DIR was still the plain checkout.
  assert.deepEqual(installs(), [`pnpm install --frozen-lockfile cwd=${dirOf(next)} live=${repo}`]);
  assert.equal(live(), dirOf(next));
  assert.equal(readlinkSync(previous), dirOf(good));
  assertRelease(dirOf(good), good);
  assertRelease(dirOf(next), next);
  assert.equal(lastDeployed(), next, "the state moved to the shared git dir");
  assert.deepEqual(restarts(), [next]);
  assert.equal(stamp().commit, next);
  assert.match(first.out, new RegExp(`version=1\\.1\\.0 commit=${next}`));
  assert.match(first.out, /bundle=index-AbC123\.js/);
  assert.match(first.out, new RegExp(`^\\[remote-update\\] release=${dirOf(next)}$`, "m"));
  assert.match(first.out, /^\[remote-update\] warm=skipped$/m);

  const third = release("ok", "1.2.0");
  const second = deploy();
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(installs()[1], `pnpm install --frozen-lockfile cwd=${dirOf(third)} live=${dirOf(next)}`);
  assert.equal(live(), dirOf(third));
  assert.equal(readlinkSync(previous), dirOf(next));
  assert.equal(lastDeployed(), third);
});

test("a failed build leaves the link and the live release untouched and deletes the half-built one", () => {
  const next = release("ok", "1.1.0");
  assert.equal(deploy().code, 0);
  const broken = release("ok", "1.2.0");
  writeFileSync(join(stubs, "fail-install"), "");
  const result = deploy();
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(live(), dirOf(next));
  assert.equal(readlinkSync(previous), dirOf(good));
  assertRelease(dirOf(next), next);
  assert.ok(!existsSync(dirOf(broken)));
  assert.deepEqual(restarts(), [next]);
  assert.equal(lastDeployed(), next);
});

test("an unhealthy release flips back to the previous one without a rebuild; the deploy fails", () => {
  const bad = release("fail", "2.0.0");
  const result = deploy();
  assert.equal(result.code, 3, result.out + result.err);
  assert.equal(live(), dirOf(good));
  assert.equal(head(), good);
  assert.ok(!existsSync(previous), "the previous link is as it was before the deploy");
  assert.equal(lastDeployed(), good, "the failed release is never recorded as deployed");
  assert.deepEqual(restarts(), [bad, good], "the previous release was restarted");
  assert.equal(readFileSync(join(stubs, "running"), "utf8").trim(), "ok");
  assert.equal(stamp().commit, good);
  assert.match(result.out, new RegExp(`version=1\\.0\\.0 commit=${good}`));
  assert.equal(installs().length, 1, "only the new release was built");
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

test("a release with its own layout-aware remote-update.sh finishes the update with it, across the conversion and under both locks; one without the marker does not", () => {
  // The release's script: this one, plus lines that report whether the shared lock and the plain
  // checkout's lock are still held (flock -n from another process fails while the update holds one).
  const lockLine = '[ "$lock_held" -eq 1 ] || echo';
  assert.ok(OURS.includes(lockLine));
  const theirs = OURS.replace(
    lockLine,
    'if flock -n "$SHARED_GIT/orq-deploy.lock" true; then echo "[release-script] shared lock free"; else echo "[release-script] shared lock held"; fi\n' +
      'if flock -n "$REPO_DIR/.git/orq-deploy.lock" true; then echo "[release-script] checkout lock free"; else echo "[release-script] checkout lock held"; fi\n' +
      lockLine
  );
  const next = release("ok", "1.1.0", { "deploy/lib/remote-update.sh": theirs });
  const result = deploy();
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /continuing with it/);
  if (HAS_FLOCK) {
    assert.match(result.out, /\[release-script\] shared lock held/);
    assert.match(result.out, /\[release-script\] checkout lock held/);
  }
  assert.match(result.out, new RegExp(`HEAD: ${good.slice(0, 7)} -> ${next.slice(0, 7)}`), "the handed-over run reports where the update started");
  assert.equal(installs().length, 1, "the worktree the first script created is built once, by the release's script");
  assert.deepEqual(restarts(), [next], "one restart, by the release's script");
  assert.equal(live(), dirOf(next));
  assertRelease(dirOf(good), good);
  assert.equal(lastDeployed(), next);

  const old = release("ok", "1.2.0", { "deploy/lib/remote-update.sh": '#!/usr/bin/env bash\necho "[old-script] ran" >> "$STUB_DIR/calls"\nexit 0\n' });
  const unmarked = deploy();
  assert.equal(unmarked.code, 0, unmarked.out + unmarked.err);
  assert.doesNotMatch(unmarked.out, /continuing with it/);
  assert.ok(!calls().includes("[old-script] ran"));
  assert.equal(live(), dirOf(old));
});

/** What an update script from before releases does: lock the checkout, reset it in place, hand over to the target's own script with its lock on fd 9. */
function preReleaseUpdate(env = {}) {
  const script = join(root, "pre-release-update.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
cd "$REPO_DIR"
[ -e .git/orq-deploy.lock ] || : > .git/orq-deploy.lock
exec 9<.git/orq-deploy.lock
flock -n 9
old_head="$(git rev-parse HEAD)"
git fetch origin -q 9<&-
git reset --hard -q origin/main
new_head="$(git rev-parse HEAD)"
handoff="$(mktemp)"
cat deploy/lib/remote-update.sh > "$handoff"
exec env ORQ_UPDATE_HANDOFF="$handoff" ORQ_UPDATE_OLD_HEAD="$old_head" ORQ_UPDATE_LOCK_HELD=1 RESET_REF="$new_head" bash "$handoff"
`
  );
  const result = spawnSync("bash", [script], { encoding: "utf8", env: hostEnv(env) });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const checkoutScript = () => readFileSync(join(repo, "deploy", "lib", "remote-update.sh"), "utf8");

test("an update a script from before releases hands over puts the plain checkout back and builds beside it", { skip: !HAS_FLOCK && "no flock on this host" }, () => {
  const next = release("ok", "1.1.0");
  const result = preReleaseUpdate();
  assert.equal(result.code, 0, result.out + result.err);
  assertRelease(dirOf(good), good);
  assert.equal(readFileSync(join(dirOf(good), "deploy", "lib", "remote-update.sh"), "utf8"), PRE_LAYOUT_SCRIPT, "the old release's tree is back at its own commit");
  assert.deepEqual(installs(), [`pnpm install --frozen-lockfile cwd=${dirOf(next)} live=${repo}`]);
  assert.equal(live(), dirOf(next));
  assert.deepEqual(restarts(), [next]);
});

test("a hand-over from a script from before releases that stops before the switch leaves the checkout at its own commit", { skip: !HAS_FLOCK && "no flock on this host" }, () => {
  release("ok", "1.1.0");
  const result = preReleaseUpdate({ RELEASE_MIN_FREE_MB: "999999999" });
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.err, /not enough disk space/);
  assert.ok(isPlainCheckout());
  assert.equal(head(), good);
  assert.equal(checkoutScript(), PRE_LAYOUT_SCRIPT);
  assert.deepEqual(restarts(), []);
});

test("a plain checkout is not converted to a release from before releases", () => {
  const old = release("ok", "1.1.0", { "deploy/lib/remote-update.sh": PRE_LAYOUT_SCRIPT });
  const result = deploy({ RESET_REF: old });
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.err, /still uses the in-place layout/);
  assert.match(result.err, /Deploy a current commit first/);
  assert.ok(isPlainCheckout());
  assert.equal(head(), good);
  assert.ok(!existsSync(sharedGit()));
  assert.ok(!existsSync(dirOf(old)));
  assert.deepEqual(restarts(), []);
});

test("a converting deploy whose release fails its health check still installs that release's update tooling", () => {
  const units = 'echo "install-unit bad" >> "$STUB_DIR/calls"\n';
  release("fail", "2.0.0", { "deploy/install-unit.sh": units, "deploy/lib/self-update.sh": "# the current self-update wrapper\n" });
  const result = deploy();
  assert.equal(result.code, 3, result.out + result.err);
  assert.equal(live(), dirOf(good));
  assert.ok(calls().includes("install-unit bad"), "the failed release installed its update unit");
  const tooling = join(releases, "tooling");
  assert.equal(readFileSync(join(tooling, "remote-update.sh"), "utf8"), OURS, "which finds layout-aware scripts, not the reverted release's");
  assert.equal(readFileSync(join(tooling, "self-update.sh"), "utf8"), "# the current self-update wrapper\n");
});

test("an update while another holds the lock touches nothing and exits 5, before and after the conversion", { skip: !HAS_FLOCK && "no flock on this host" }, () => {
  release("ok", "1.1.0");
  const held = (lock) => {
    writeFileSync(lock, "");
    // flock(1) holds the lock while it runs the deploy, which opens the file again and must not get it.
    return spawnSync("flock", [lock, "bash", SCRIPT], { encoding: "utf8", env: hostEnv() });
  };
  const before = held(join(repo, ".git", "orq-deploy.lock"));
  assert.equal(before.status, 5, before.stderr);
  assert.match(before.stderr, /another update is running/);
  assert.ok(isPlainCheckout(), "the checkout was not converted");
  assert.ok(!existsSync(sharedGit()));
  assert.deepEqual(restarts(), []);

  assert.equal(deploy().code, 0);
  const next = release("ok", "1.2.0");
  const after = held(join(sharedGit(), "orq-deploy.lock"));
  assert.equal(after.status, 5, after.stderr);
  assert.notEqual(live(), dirOf(next));
  assert.ok(!existsSync(dirOf(next)));
  assert.equal(restarts().length, 1);
});

test("a re-deploy or manual rollback to a kept release switches without a rebuild, and a later unhealthy deploy reverts to it", () => {
  const second = release("ok", "1.1.0");
  assert.equal(deploy().code, 0);
  assert.equal(lastDeployed(), second);
  const back = deploy({ RESET_REF: good });
  assert.equal(back.code, 0, back.err);
  assert.equal(head(), good);
  assert.equal(live(), dirOf(good));
  assert.equal(readlinkSync(previous), dirOf(second));
  assert.equal(lastDeployed(), good);
  assert.equal(stamp().commit, good);
  const again = deploy({ RESET_REF: second });
  assert.equal(again.code, 0, again.err);
  assert.equal(live(), dirOf(second));
  assert.equal(installs().length, 1, "only the first deploy of the second release built anything");
  assert.deepEqual(restarts(), [second, good, second]);
  assert.equal(deploy({ RESET_REF: good }).code, 0);
  release("fail", "3.0.0");
  assert.equal(deploy().code, 3);
  assert.equal(head(), good, "reverted to the release the rollback installed");
});

test("a release from before releases is deployed by this script, and neither its units nor its update scripts are installed", () => {
  const units = (tag) => `echo "install-unit ${tag}" >> "$STUB_DIR/calls"\n`;
  const old = release("ok", "1.1.0", {
    "deploy/lib/remote-update.sh": '#!/usr/bin/env bash\necho "[old-script] ran" >> "$STUB_DIR/calls"\nexit 0\n',
    "deploy/install-unit.sh": units("old")
  });
  const current = release("ok", "1.2.0", {
    "deploy/install-unit.sh": units("current"),
    "deploy/lib/ensure-web-fallback.sh": 'echo "web-fallback $1" >> "$STUB_DIR/calls"\n',
    "deploy/lib/self-update.sh": "# the current self-update wrapper\n"
  });
  const tooling = join(releases, "tooling");
  assert.equal(deploy({ ENV_FILE: "/env-file" }).code, 0);
  assert.equal(readFileSync(join(tooling, "remote-update.sh"), "utf8"), OURS);
  assert.equal(readFileSync(join(tooling, "self-update.sh"), "utf8"), "# the current self-update wrapper\n");
  assert.equal(lstatSync(join(tooling, "self-update.sh")).mode & 0o777, 0o644);
  const rollback = deploy({ RESET_REF: old });
  assert.equal(rollback.code, 0, rollback.out + rollback.err);
  assert.equal(live(), dirOf(old));
  assert.equal(readlinkSync(previous), dirOf(current));
  assert.deepEqual(restarts(), [current, old]);
  assert.deepEqual(
    calls().filter((line) => /^(install-unit|web-fallback|\[old-script\])/.test(line)),
    ["web-fallback /env-file", "install-unit current"],
    "only the layout-aware release installed units; the old release's script never ran"
  );
  assert.equal(readFileSync(join(tooling, "remote-update.sh"), "utf8"), OURS, "the rollback left the layout-aware tooling");
  assert.deepEqual(readdirSync(tooling).sort(), ["remote-update.sh", "self-update.sh"]);
});

test("a release whose daemon keeps crashing is flipped back at once, not after the whole health wait", () => {
  release("fail", "2.0.0");
  const result = deploy({ HEALTH_WAIT: "600" });
  assert.equal(result.code, 3, result.out + result.err);
  assert.match(result.err, /crashed and was restarted 2 times/);
  const healthChecks = readFileSync(join(stubs, "calls"), "utf8").split("\n").filter((line) => line === "curl health").length;
  assert.ok(healthChecks < 10, `gave up after ${healthChecks} health checks, not ${600}`);
});

test("a release that is slow to come up (no crash) still gets the whole health wait", () => {
  release("fail", "2.0.0");
  writeFileSync(join(stubs, "hangs"), "");
  const result = deploy({ HEALTH_WAIT: "3" });
  assert.equal(result.code, 3, result.out + result.err);
  assert.doesNotMatch(result.err, /crashed and was restarted/);
  const healthChecks = readFileSync(join(stubs, "calls"), "utf8").split("\n").filter((line) => line === "curl health").length;
  assert.ok(healthChecks >= 3, `waited through ${healthChecks} health checks`);
});

test("pruning keeps the live, previous and one more release, and every release a running process uses", () => {
  const shas = [];
  for (let i = 1; i <= 6; i++) shas.push(release("ok", `1.${i}.0`));
  // A process with its cwd in the converted release, one mapping a file of release 1, one whose
  // command line names release 2 (written before the deploys: they prune too).
  mkdirSync(join(proc, "100"));
  symlinkSync(join(dirOf(good), "apps", "daemon"), join(proc, "100", "cwd"));
  mkdirSync(join(proc, "200"));
  writeFileSync(join(proc, "200", "maps"), `7f00-7f01 r-xp 00000000 08:01 42 ${dirOf(shas[0])}/node_modules/better-sqlite3/build/Release/better_sqlite3.node\n`);
  mkdirSync(join(proc, "300"));
  writeFileSync(join(proc, "300", "cmdline"), `/usr/bin/node\0--import\0tsx\0${dirOf(shas[1])}/apps/daemon/src/agent-host/main.ts\0`);
  mkdirSync(join(proc, "400"));
  symlinkSync("/usr/bin/node", join(proc, "400", "exe"));
  let last;
  for (const sha of shas) {
    last = deploy({ RESET_REF: sha });
    assert.equal(last.code, 0, last.out + last.err);
  }
  const kept = [good, ...shas].filter((sha) => existsSync(dirOf(sha)));
  assert.deepEqual(kept, [good, shas[0], shas[1], shas[3], shas[4], shas[5]], "release 3 is the only one no one needs");
  assert.match(last.err, /WARNING: 6 releases kept/);
  const listed = git(sharedGit(), "worktree", "list", "--porcelain");
  assert.ok(!listed.includes(dirOf(shas[2])), "the pruned release is gone from git too");
  assert.ok(!/prunable|locked/.test(listed), listed);
});

test("pruning's extra rollback target is the last healthy release, never a failed one or one kept anyway", () => {
  // good -> B -> C (unhealthy, flipped back to B) -> rollback to good -> D, with a process still in C.
  const b = release("ok", "2.0.0");
  assert.equal(deploy().code, 0);
  const c = release("fail", "3.0.0");
  assert.equal(deploy().code, 3);
  assert.equal(deploy({ RESET_REF: good }).code, 0);
  mkdirSync(join(proc, "500"));
  symlinkSync(join(dirOf(c), "apps", "daemon"), join(proc, "500", "cwd"));
  const d = release("ok", "4.0.0");
  const result = deploy();
  assert.equal(result.code, 0, result.out + result.err);
  assert.ok(existsSync(dirOf(d)) && existsSync(dirOf(good)), "live and previous");
  assert.ok(existsSync(dirOf(c)), "the release a process uses");
  assert.ok(existsSync(dirOf(b)), "B, the last release that ran healthy, stays as the extra rollback target");
});

test("a conversion interrupted at any step is finished by the next update", async (t) => {
  // Each case leaves the host as a run killed at that point would; the next deploy must end with
  // the same layout as an uninterrupted one.
  const failedBuild = () => {
    writeFileSync(join(stubs, "fail-install"), "");
    const failed = deploy();
    assert.equal(failed.code, 1, failed.out + failed.err);
    assert.ok(isPlainCheckout(), "a failed build leaves the plain checkout as it was");
    rmSync(join(stubs, "fail-install"));
  };
  const cases = {
    "while copying the git dir": () => {
      mkdirSync(join(releases, "repo.git.tmp", "objects"), { recursive: true });
      writeFileSync(join(releases, "repo.git.tmp", "HEAD"), "garbage\n");
    },
    "after copying the git dir": () => {
      cpSync(join(repo, ".git"), sharedGit(), { recursive: true });
      git(root, "--git-dir", sharedGit(), "config", "--bool", "core.bare", "true");
    },
    "after a failed build": failedBuild,
    "between moving the checkout and linking it": () => {
      failedBuild();
      renameSync(repo, dirOf(good));
    },
    "after linking it, before its own .git was replaced": () => {
      failedBuild();
      renameSync(repo, dirOf(good));
      symlinkSync(dirOf(good), repo);
    },
    "with its own .git set aside": () => {
      failedBuild();
      renameSync(repo, dirOf(good));
      symlinkSync(dirOf(good), repo);
      renameSync(join(dirOf(good), ".git"), join(dirOf(good), ".git-pre-layout"));
    },
    "with the set-aside .git not yet deleted": () => {
      failedBuild();
      renameSync(repo, dirOf(good));
      symlinkSync(dirOf(good), repo);
      renameSync(join(dirOf(good), ".git"), join(dirOf(good), ".git-pre-layout"));
      writeFileSync(join(dirOf(good), ".git"), `gitdir: ${join(sharedGit(), "worktrees", good.slice(0, 12))}\n`);
    }
  };
  for (const [name, interrupt] of Object.entries(cases)) {
    await t.test(name, () => {
      // A fresh host for each case.
      rmSync(root, { recursive: true, force: true });
      setUpHost();
      const next = release("ok", "1.1.0");
      mkdirSync(releases, { recursive: true });
      interrupt();
      rmSync(join(stubs, "calls"), { force: true });
      const result = deploy();
      assert.equal(result.code, 0, result.out + result.err);
      assert.equal(live(), dirOf(next));
      assert.equal(readlinkSync(previous), dirOf(good));
      assertRelease(dirOf(good), good);
      assertRelease(dirOf(next), next);
      assert.ok(!existsSync(join(releases, "repo.git.tmp")));
      assert.equal(installs().length, 1);
      assert.deepEqual(restarts(), [next]);
      const listed = git(sharedGit(), "worktree", "list", "--porcelain");
      assert.ok(!/prunable|locked/.test(listed), listed);
    });
  }
});

test("a plain checkout an in-place update left half-built is rebuilt in place when its commit is deployed", () => {
  // An updater from before releases reset the checkout to `current` and stopped before its stamp.
  const current = release("ok", "1.1.0");
  git(repo, "fetch", "-q", "origin");
  git(repo, "reset", "-q", "--hard", current);
  const result = deploy({ RESET_REF: current });
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual(installs(), [`pnpm install --frozen-lockfile cwd=${repo} live=${repo}`]);
  assert.equal(live(), dirOf(current));
  assertRelease(dirOf(current), current);
  assert.deepEqual(restarts(), [current]);
});

test("a release whose tree was reset in place to another commit is rebuilt, not reused, when its commit is deployed", () => {
  const next = release("ok", "1.1.0");
  assert.equal(deploy().code, 0);
  release("ok", "1.2.0");
  assert.equal(deploy().code, 0);
  // The previous release, marked complete as `next`, now holds another commit's tree.
  git(dirOf(next), "reset", "-q", "--hard", good);
  const result = deploy({ RESET_REF: next });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(installs().length, 3, "built again");
  assert.equal(live(), dirOf(next));
  assertRelease(dirOf(next), next);
  assert.equal(restarts().at(-1), next);
});

test("an update that would leave the volume nearly full is refused before anything changes", () => {
  release("ok", "1.1.0");
  const result = deploy({ RELEASE_MIN_FREE_MB: "999999999" });
  assert.equal(result.code, 1);
  assert.match(result.err, /not enough disk space/);
  assert.ok(isPlainCheckout());
  assert.ok(!existsSync(sharedGit()));
  assert.deepEqual(restarts(), []);
});

test("an unknown ref fails before touching the tree", () => {
  const result = deploy({ RESET_REF: "0000000000000000000000000000000000000000" });
  assert.equal(result.code, 1);
  assert.equal(head(), good);
  assert.ok(isPlainCheckout());
  assert.match(result.err, /ref not found/);
  assert.deepEqual(restarts(), []);
});

test("the warm-up runs in the new release before the switch, and a failure only warns", () => {
  const warm = 'echo "warm $1 cwd=$PWD live=$(readlink -f "$REPO_DIR")" >> "$STUB_DIR/calls"\n';
  const next = release("ok", "1.1.0", { "deploy/lib/warm-release.sh": warm });
  const warmed = deploy();
  assert.equal(warmed.code, 0, warmed.err);
  assert.ok(calls().includes(`warm ${dirOf(next)} cwd=${dirOf(next)} live=${repo}`));
  assert.match(warmed.out, /^\[remote-update\] warm=ok$/m);

  const failing = release("ok", "1.2.0", { "deploy/lib/warm-release.sh": "exit 7\n" });
  const failed = deploy();
  assert.equal(failed.code, 0, failed.err);
  assert.equal(live(), dirOf(failing));
  assert.match(failed.out, /^\[remote-update\] warm=FAILED: deploy\/lib\/warm-release\.sh exited 7$/m);
  assert.match(failed.err, /WARNING: warm-up FAILED/);
});

test("with SUDO=sudo, which resets the environment, WARM_TIMEOUT still reaches the warm-up, and a timed-out one says so", () => {
  const warm = 'echo "warm timeout=${WARM_TIMEOUT:-unset}" >> "$STUB_DIR/calls"\nexit 124\n';
  const next = release("ok", "1.1.0", { "deploy/lib/warm-release.sh": warm });
  const result = deploy({ SUDO: join(stubs, "bin", "fake-sudo"), WARM_TIMEOUT: "42" });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(live(), dirOf(next));
  assert.ok(calls().includes("warm timeout=42"), calls().join("\n"));
  assert.match(result.out, /^\[remote-update\] warm=FAILED: deploy\/lib\/warm-release\.sh timed out after 42s$/m);
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

test("gdu's install is best-effort: its version is reported, and a failure only warns", () => {
  const ok = release("ok", "1.1.0", {
    "deploy/install-gdu.sh": "echo '[install-gdu] gdu v5.39.0 at /opt/orquester-tools/gdu/v5.39.0/gdu'\n"
  });
  const installed = deploy();
  assert.equal(installed.code, 0, installed.err);
  assert.match(installed.out, /gdu=v5\.39\.0$/m);

  const failing = release("ok", "1.2.0", {
    "deploy/install-gdu.sh": "echo '[install-gdu] ERROR: sha256 mismatch for gdu_linux_amd64_static.tgz (v5.39.0) — not installing' >&2\nexit 1\n"
  });
  const failed = deploy();
  assert.equal(failed.code, 0, failed.err);
  assert.equal(head(), failing);
  assert.deepEqual(restarts(), [ok, failing], "the daemon is restarted all the same");
  assert.match(failed.out, /gdu=FAILED: sha256 mismatch for gdu_linux_amd64_static\.tgz \(v5\.39\.0\) — not installing$/m);
  assert.match(failed.err, /WARNING: gdu not installed/);
});

test("a release without install-voxl.sh or install-gdu.sh skips them", () => {
  release("ok", "1.1.0");
  const result = deploy();
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /voxl=skipped$/m);
  assert.match(result.out, /gdu=skipped$/m);
});
