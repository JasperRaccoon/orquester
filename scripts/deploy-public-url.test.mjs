// deploy/lib/ensure-public-url.sh: deploy adds ORQUESTER_PUBLIC_URL to daemon.env from the
// target's domain, never overwrites an existing value, and keeps the file 0600.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "deploy", "lib", "ensure-public-url.sh");

function envFile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "orq-public-url-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "daemon.env");
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  return file;
}

const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });
const mode = (file) => statSync(file).mode & 0o777;

test("adds ORQUESTER_PUBLIC_URL from the domain when the file has none", (t) => {
  const file = envFile(t, "ORQUESTER_HTTP_PORT=47831\n# ORQUESTER_PUBLIC_URL=https://orquester.example.com\nHOME=/var/lib/orquester");
  const result = run(file, "orq.example.com");
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(file, "utf8").split("\n");
  // The missing final newline was added before appending; the commented example does not count.
  assert.ok(lines.includes("HOME=/var/lib/orquester"));
  assert.ok(lines.includes("ORQUESTER_PUBLIC_URL=https://orq.example.com"));
  assert.equal(lines.filter((line) => line.startsWith("ORQUESTER_PUBLIC_URL=")).length, 1);
  assert.equal(mode(file), 0o600);
  // Idempotent: a second run adds nothing.
  const before = readFileSync(file, "utf8");
  assert.equal(run(file, "orq.example.com").status, 0);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("never overwrites an existing value", (t) => {
  const content = "ORQUESTER_PUBLIC_URL=https://custom.example.net\n";
  const file = envFile(t, content);
  const result = run(file, "orq.example.com");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already set/);
  assert.equal(readFileSync(file, "utf8"), content);
});

test("does nothing without a domain, and refuses a domain that could inject", (t) => {
  const file = envFile(t, "A=1\n");
  assert.equal(run(file, "").status, 0);
  assert.equal(readFileSync(file, "utf8"), "A=1\n");
  const bad = run(file, "x.com\nEVIL=1");
  assert.notEqual(bad.status, 0);
  assert.equal(readFileSync(file, "utf8"), "A=1\n");
});
