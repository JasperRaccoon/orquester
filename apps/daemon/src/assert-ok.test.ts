import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("message-less assertions in a long tsx module fail promptly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-assert-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, "failure.ts");
  // Node 20's generated-message lookup applies esbuild's positions to the raw
  // TypeScript. A large source with type syntax reproduced a minutes-long hang.
  await writeFile(fixture, [
    'import assert from "node:assert/strict";',
    'type Row = { payload?: { ready?: boolean } };',
    'const rows: Row[] = [{ payload: {} }];',
    '// TypeScript source padding\n'.repeat(1500),
    'process.stdout.write("ready\\n");',
    'process.stdin.once("data", () => {',
    'let failures = 0;',
    'for (const check of [() => assert.ok(rows[0].payload?.ready === true), () => assert(rows[0].payload?.ready === true)]) {',
    '  try { check(); } catch (error) {',
    '    if (!(error instanceof assert.AssertionError) || error.actual !== false) throw error;',
    '    failures++;',
    '  }',
    '}',
    'process.stdout.write(String(failures));',
    'process.stdin.destroy();',
    '});'
  ].join("\n"));
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--import", fileURLToPath(new URL("../../../scripts/test/assert-ok.mjs", import.meta.url)),
    fixture
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    // Module startup is not the assertion latency regression. Begin its
    // unchanged deadline only after the loaded child is ready to run checks.
    const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(60_000) });
    assert.equal(String(ready), "ready\n", stderr);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exited = once(child, "close", { signal: AbortSignal.timeout(10_000) });
    child.stdin.end("run\n");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "2", "both failing entrypoints completed with AssertionError");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
