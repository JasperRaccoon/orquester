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
  // Keep the measurement outside the position-sensitive regression fixture.
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, [
    'const before = process.cpuUsage();',
    'await import("./failure.mts");',
    'const { user, system } = process.cpuUsage(before);',
    'process.send((user + system) / 1000, () => process.disconnect());'
  ].join("\n"));
  // Pass and fail are decided on CPU time, never wall time: the regression is a CPU-bound re-parse,
  // and on a loaded host (ten runnable processes per core) the wall time of a healthy run is
  // unbounded. The kernel SIGKILLs the Node child once it has burnt CPU_LIMIT_S (RLIMIT_CPU, soft =
  // hard); a helper process it starts, such as esbuild's, counts against its own copy of the limit,
  // not this one. ASSERTIONS_CPU_MS bounds the Node child's CPU time over the assertions, which
  // include the first one's lazy TypeScript parser load, and excludes the loader startup before them.
  // HANG_GUARD_MS is only a safety net for a child blocked without burning CPU (an IPC or loader
  // deadlock), which no CPU limit ends: far above any healthy run, it fails the test, never passes it.
  const CPU_LIMIT_S = 60;
  const ASSERTIONS_CPU_MS = 10_000;
  const HANG_GUARD_MS = 10 * 60_000;
  const node = [
    process.execPath,
    "--import", import.meta.resolve("tsx"),
    "--import", fileURLToPath(new URL("../../../scripts/test/assert-ok.mjs", import.meta.url)),
    runner
  ];
  const child = spawn("/bin/sh", ["-c", `ulimit -t ${CPU_LIMIT_S} && exec "$@"`, "sh", ...node], {
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  t.after(() => { child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  let assertionsCpuMs: number | undefined;
  child.once("message", (cpuMs) => { assertionsCpuMs = cpuMs as number; });
  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(HANG_GUARD_MS) }).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw new Error(`hang guard: the child was still running after ${HANG_GUARD_MS / 60_000} min: ${stderr}`, { cause: error });
  });
  assert.equal(signal, null, `the child was killed (its CPU limit is ${CPU_LIMIT_S} s): ${stderr}`);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "2", "both failing entrypoints completed with AssertionError");
  assert.ok(assertionsCpuMs !== undefined, "the runner reported its CPU time");
  assert.ok(assertionsCpuMs < ASSERTIONS_CPU_MS, `the assertions took ${assertionsCpuMs} ms of CPU`);
});
