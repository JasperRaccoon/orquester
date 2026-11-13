// deploy/lib/ensure-web-fallback.sh: deploy adds ORQUESTER_WEB_FALLBACK_DIR to daemon.env, never
// overwrites an existing value, and keeps the file 0600.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "ensure-web-fallback.sh");
const LINE = "ORQUESTER_WEB_FALLBACK_DIR=/opt/orquester-previous/apps/web/dist";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "orq-web-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envFile(t, content) {
  const file = join(tempDir(t), "daemon.env");
  writeFileSync(file, content);
  chmodSync(file, 0o644);
  return file;
}

const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

test("adds the previous release's web dir when the file has none, once", (t) => {
  const file = envFile(t, "# ORQUESTER_WEB_FALLBACK_DIR=/elsewhere\nHOME=/var/lib/orquester");
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(file, "utf8").split("\n");
  // The missing final newline was added before appending; the commented example does not count.
  assert.ok(lines.includes("HOME=/var/lib/orquester"));
  assert.equal(lines.filter((line) => line.startsWith("ORQUESTER_WEB_FALLBACK_DIR=")).join("\n"), LINE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = readFileSync(file, "utf8");
  assert.equal(run(file).status, 0);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("never overwrites an existing value, even an empty one", (t) => {
  for (const content of ["ORQUESTER_WEB_FALLBACK_DIR=/srv/old-web\n", "ORQUESTER_WEB_FALLBACK_DIR=\n"]) {
    const file = envFile(t, content);
    const result = run(file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), content);
  }
});

test("fails without creating a missing env file", (t) => {
  const file = join(tempDir(t), "daemon.env");
  assert.notEqual(run(file).status, 0);
  assert.equal(existsSync(file), false);
});
