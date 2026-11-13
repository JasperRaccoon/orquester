// Runs deploy/lib/warm-release.sh as the current user against a throwaway release: a daemon and an
// agent host entry whose module bodies write a marker file, so a warm-up that ran any of them
// would show. The repository's own tsx is linked in, as a release's node_modules would hold it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SCRIPT = join(HERE, "warm-release.sh");

let root = "";
let release = "";
let daemonTmp = "";

const cacheEntries = () => {
  const dir = join(daemonTmp, `tsx-${process.getuid()}`);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

function write(path, text) {
  mkdirSync(dirname(join(release, path)), { recursive: true });
  writeFileSync(join(release, path), text);
}

function warm(dir = release) {
  return spawnSync("bash", [SCRIPT, dir], {
    encoding: "utf8",
    env: { ...process.env, DAEMON_USER: userInfo().username, DAEMON_TMPDIR: daemonTmp }
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "warm-release-")));
  release = join(root, "release");
  daemonTmp = join(root, "daemon-tmp");
  write("package.json", JSON.stringify({ type: "module" }));
  mkdirSync(join(release, "node_modules"));
  symlinkSync(realpathSync(join(REPO, "node_modules", "tsx")), join(release, "node_modules", "tsx"));
  mkdirSync(join(release, "deploy", "lib"), { recursive: true });
  copyFileSync(join(HERE, "warm-release.mjs"), join(release, "deploy", "lib", "warm-release.mjs"));
  const sideEffect = (name) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, name))}, "ran");\n`;
  write("apps/daemon/src/lib.ts", "export const port: number = 1;\n");
  write("apps/daemon/src/cli.ts", `${sideEffect("daemon-ran")}import { port } from "./lib.ts";\nconsole.log(port satisfies number);\n`);
  write("apps/daemon/src/agent-host/main.ts", `${sideEffect("host-ran")}import { port } from "../lib.ts";\nexport const host: number = port;\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("warms every module of both graphs without running them, and the real start hits the cache", () => {
  const result = warm();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[warm-release\] warmed 3 modules in [\d.]+s/);
  assert.equal(cacheEntries().length, 3);
  assert.deepEqual(readdirSync(root).sort(), ["daemon-tmp", "release"], "no module body ran");

  const warmed = cacheEntries();
  // Started through a symlink, as /opt/orquester points at the release: node resolves the real path.
  symlinkSync(release, join(root, "live"));
  const start = spawnSync(process.execPath, ["--import", "tsx", join(root, "live", "apps/daemon/src/cli.ts")], {
    cwd: join(root, "live"),
    encoding: "utf8",
    env: { PATH: process.env.PATH, TMPDIR: daemonTmp }
  });
  assert.equal(start.status, 0, start.stderr);
  assert.ok(existsSync(join(root, "daemon-ran")), "the fixture's start does run its body");
  assert.deepEqual(cacheEntries(), warmed, "the start transformed nothing anew");

  assert.equal(warm().status, 0);
  assert.deepEqual(cacheEntries(), warmed, "a second warm-up adds nothing");
});

test("fails when the graph does not load", () => {
  write("apps/daemon/src/agent-host/main.ts", `import "./missing.ts";\n`);
  const result = warm();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.ts/);
});
