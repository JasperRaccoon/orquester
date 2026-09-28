import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    'let failures = 0;',
    'for (const check of [() => assert.ok(rows[0].payload?.ready === true), () => assert(rows[0].payload?.ready === true)]) {',
    '  try { check(); } catch (error) {',
    '    if (!(error instanceof assert.AssertionError) || error.actual !== false) throw error;',
    '    failures++;',
    '  }',
    '}',
    'process.stdout.write(String(failures));'
  ].join("\n"));
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--import", fileURLToPath(new URL("../../../scripts/test/assert-ok.mjs", import.meta.url)),
    fixture
  ], { timeout: 10_000 });
  assert.equal(stdout, "2", "both failing entrypoints completed with AssertionError");
});
