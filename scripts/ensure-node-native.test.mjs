import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detachBuildFiles, ensureNodeNative, main, probeInChild } from "./ensure-node-native.mjs";

const sqlite = { name: "better-sqlite3", probe: "" };
const pty = { name: "node-pty", probe: "" };

/** A probe that answers from a per-module queue of results (null = loads). */
function scriptedProbe(answers) {
  const calls = [];
  return {
    calls,
    probe(mod) {
      calls.push(mod.name);
      const queue = answers[mod.name];
      return queue.length > 1 ? queue.shift() : queue[0];
    }
  };
}

function recorder(result = true) {
  const calls = [];
  return { calls, rebuild: (names) => (calls.push(names), result) };
}

test("does nothing when every module loads", () => {
  const { probe, calls } = scriptedProbe({ "better-sqlite3": [null], "node-pty": [null] });
  const rebuild = recorder();
  const result = ensureNodeNative({ modules: [sqlite, pty], probe, rebuild: rebuild.rebuild, log: () => {} });
  assert.deepEqual(result, { ok: true, rebuilt: [], broken: [] });
  assert.deepEqual(rebuild.calls, [], "no rebuild when everything loads");
  assert.deepEqual(calls, ["better-sqlite3", "node-pty"]);
});

test("rebuilds only the failing module, once, then re-checks it", () => {
  const { probe, calls } = scriptedProbe({
    "better-sqlite3": ["NODE_MODULE_VERSION 130 vs 115", null],
    "node-pty": [null]
  });
  const rebuild = recorder();
  const result = ensureNodeNative({ modules: [sqlite, pty], probe, rebuild: rebuild.rebuild, log: () => {} });
  assert.deepEqual(result, { ok: true, rebuilt: ["better-sqlite3"], broken: [] });
  assert.deepEqual(rebuild.calls, [["better-sqlite3"]], "one rebuild of the failing module");
  assert.deepEqual(calls, ["better-sqlite3", "node-pty", "better-sqlite3"]);
});

test("rebuilds all failing modules in a single call", () => {
  const { probe } = scriptedProbe({ "better-sqlite3": ["bad", null], "node-pty": ["bad", null] });
  const rebuild = recorder();
  const result = ensureNodeNative({ modules: [sqlite, pty], probe, rebuild: rebuild.rebuild, log: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(rebuild.calls, [["better-sqlite3", "node-pty"]]);
});

test("still broken after rebuild: not ok, and main exits non-zero with the reason", () => {
  const { probe } = scriptedProbe({ "better-sqlite3": ["Module did not self-register"], "node-pty": [null] });
  const rebuild = recorder(false);
  const errors = [];
  const code = main({ modules: [sqlite, pty], probe, rebuild: rebuild.rebuild, log: () => {}, error: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(rebuild.calls, [["better-sqlite3"]], "rebuild is attempted exactly once");
  assert.ok(
    errors.some((line) => line.includes("better-sqlite3") && line.includes("Module did not self-register")),
    `error output names the module and the cause: ${errors.join(" | ")}`
  );
});

test("a rebuild that reports failure but fixes the module still passes", () => {
  const { probe } = scriptedProbe({ "better-sqlite3": ["bad", null], "node-pty": [null] });
  const rebuild = recorder(false);
  assert.equal(main({ modules: [sqlite, pty], probe, rebuild: rebuild.rebuild, log: () => {}, error: () => {} }), 0);
});

test("the real child probe reports load success and failure", () => {
  assert.equal(probeInChild({ name: "fs", probe: "require('node:fs');" }), null);
  const error = probeInChild({ name: "missing", probe: "require('orquester-no-such-native-module');" });
  assert.match(error ?? "", /Cannot find module/);
});

test("detachBuildFiles gives hard-linked build files their own inode, content and mode intact", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensure-node-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "store-file");
  writeFileSync(store, "node-abi-binary");
  chmodSync(store, 0o755);
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "build", "Release"), { recursive: true });
  const binary = join(pkg, "build", "Release", "addon.node");
  linkSync(store, binary);
  const own = join(pkg, "build", "Release", "own.txt");
  writeFileSync(own, "private");
  const outside = join(pkg, "index.js");
  linkSync(store, outside);

  assert.equal(detachBuildFiles(pkg), 1, "only the linked file under build/ is copied");
  assert.equal(statSync(binary).nlink, 1);
  assert.notEqual(statSync(binary).ino, statSync(store).ino);
  assert.equal(readFileSync(binary, "utf8"), "node-abi-binary");
  assert.equal(statSync(binary).mode & 0o777, 0o755);
  writeFileSync(binary, "electron-abi-binary");
  assert.equal(readFileSync(store, "utf8"), "node-abi-binary", "a later in-place write no longer reaches the store");
  assert.equal(statSync(outside).ino, statSync(store).ino, "files outside build/ stay linked");
  assert.equal(detachBuildFiles(pkg), 0, "idempotent");
  assert.equal(detachBuildFiles(join(root, "missing")), 0, "no build/ is fine");
});
