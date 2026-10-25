/**
 * Reproduce a usage-widget refresh against a long-lived transcript history:
 *   TSX_DISABLE_CACHE=1 node --import tsx src/usage-tokens.bench.ts
 *
 * Optional module path compares another revision with the same fixtures:
 *   ... src/usage-tokens.bench.ts /absolute/path/to/usage-tokens.ts
 * Reports median wall/CPU time; setup is outside the measured region.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UsageTokensScanner as Scanner } from "./usage-tokens.ts";

const { UsageTokensScanner } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "./usage-tokens.ts") as { UsageTokensScanner: typeof Scanner };
const previousClaude = process.env.CLAUDE_CONFIG_DIR;
const previousCodex = process.env.CODEX_HOME;
const home = await mkdtemp(join(tmpdir(), "orquester-usage-bench-"));
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");
  for (const [files, turnsPerFile] of [[128, 256], [1024, 8]] as const) {
    const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects");
    await rm(projects, { recursive: true, force: true });
    await mkdir(projects, { recursive: true });
    for (let file = 0; file < files; file += 1) {
      const lines = Array.from({ length: turnsPerFile }, (_, turn) => JSON.stringify({
        timestamp: "2026-10-01T00:00:00Z",
        requestId: `request-${file}-${turn}`,
        message: { id: `message-${file}-${turn}`, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 2 } }
      }));
      await writeFile(join(projects, `${file}.jsonl`), `${lines.join("\n")}\n`);
    }
    const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "cache.json"), now: () => Date.parse("2026-10-25T00:00:00Z") });
    await scanner.snapshot(true);
    const wall: number[] = [];
    const cpu: number[] = [];
    for (let run = 0; run < 13; run += 1) {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const result = await scanner.snapshot(true);
      const elapsed = performance.now() - start;
      const usage = process.cpuUsage(cpuStart);
      assert.equal(result.rows[0]?.inputTokens, files * turnsPerFile * 10);
      if (run >= 3) {
        wall.push(elapsed);
        cpu.push((usage.user + usage.system) / 1000);
      }
    }
    console.log(JSON.stringify({ files, turns: files * turnsPerFile, refreshMedianMs: median(wall), cpuMedianMs: median(cpu), samples: wall.length }));
  }
} finally {
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  if (previousCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodex;
  await rm(home, { recursive: true, force: true });
}
