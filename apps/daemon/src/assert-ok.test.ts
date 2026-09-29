import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("message-less assertions in a long tsx module fail promptly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-assert-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The temp directory is outside our type:module package; keep the fixture ESM
  // so callable assert imports pass through the assertion preload's loader hook.
  const fixture = join(dir, "failure.mts");
  // Node 20's generated-message lookup applies esbuild's positions to the raw
  // TypeScript. A large source with type syntax reproduced a minutes-long hang.
  await writeFile(fixture, [
    'import assert from "node:assert/strict";',
    'type Row = { payload?: { ready?: boolean } };',
    'const rows: Row[] = [{ payload: {} }];',
    '// TypeScript source padding\n'.repeat(1500),
    'let failures = 0;',
    'for (const check of [() => assert.ok(rows[0].payload?.ready === true), () => assert(rows[0].payload?.ready === true)]) {',
    '  try { check(); } catch (error) {',
    '    if (!(error instanceof assert.AssertionError) || error.actual !== false) throw error;',
    '    const expression = failures === 0 ? "assert.ok(rows[0].payload?.ready === true)" : "assert(rows[0].payload?.ready === true)";',
    '    if (!error.message.includes(expression)) throw new Error(`Wrong assertion source: ${error.message}`);',
    '    failures++;',
    '  }',
    '}',
    'process.stdout.write(String(failures));'
  ].join("\n"));
  // Keep the handshake outside the position-sensitive regression fixture.
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, [
    'await new Promise((resolve) => {',
    '  process.once("message", resolve);',
    '  process.send("ready");',
    '});',
    'await import("./failure.mts");',
    'process.disconnect();'
  ].join("\n"));
  const child = fork(runner, [], {
    execArgv: [
      "--import", import.meta.resolve("tsx"),
      "--import", fileURLToPath(new URL("../../../scripts/test/assert-ok.mjs", import.meta.url))
    ],
    silent: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  let phase = "startup";
  let timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.once("message", () => {
    clearTimeout(timer);
    phase = "assertions";
    // Exclude loader startup, but include the first assertion's lazy parser load.
    timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.send("run");
  });
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, `${phase} exceeded its deadline: ${stderr}`);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "2", "both failing entrypoints completed with AssertionError");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});
