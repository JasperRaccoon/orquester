import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_MODULES, ensureNodeNative, main, probeInChild } from "./ensure-node-native.mjs";

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

test("covers the daemon's native modules", () => {
  assert.deepEqual(NATIVE_MODULES.map((mod) => mod.name).sort(), ["better-sqlite3", "node-pty"]);
});

test("the real child probe reports load success and failure", () => {
  assert.equal(probeInChild({ name: "fs", probe: "require('node:fs');" }), null);
  const error = probeInChild({ name: "missing", probe: "require('orquester-no-such-native-module');" });
  assert.match(error ?? "", /Cannot find module/);
});
