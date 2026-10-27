/**
 * Codex quota fallback against long rollout histories (no credentials/network):
 *   TSX_DISABLE_CACHE=1 node --import tsx src/usage-sources.bench.ts
 * Optional module path runs another revision against identical fixtures.
 * Setup is excluded; every sample checks the complete returned usage reading.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentUsage } from "@orquester/api";
import type { createCodexSource as Source } from "./usage-sources.ts";

const { createCodexSource } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "./usage-sources.ts") as { createCodexSource: typeof Source };
const home = await mkdtemp(join(tmpdir(), "orquester-codex-usage-bench-"));
const now = Date.parse("2026-10-25T00:00:00Z");
const rateLimits = {
  primary: { used_percent: 23, window_minutes: 300, resets_at: now / 1000 + 3600 },
  secondary: { used_percent: 45, window_minutes: 10080, resets_at: now / 1000 + 86_400 }
};
const reading = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } });
const filler = `${JSON.stringify({ type: "response_item", payload: { content: "tool output ".repeat(100) } })}\n`;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  const path = join(sessions, "rollout-benchmark.jsonl");
  const source = createCodexSource({ userhome: home, codexHome: home, now: () => now });
  await writeFile(path, `${reading}\n`);
  const expected = await source();
  assert.equal(expected?.session?.percent, 23);
  assert.equal(expected?.weekly?.percent, 45);
  async function measure(scenario: string, megabytes: number, text: string, expected: AgentUsage | null) {
    await writeFile(path, text);
    const wall: number[] = [];
    const cpu: number[] = [];
    for (let run = 0; run < 13; run += 1) {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const actual = await source();
      const elapsed = performance.now() - start;
      const used = process.cpuUsage(cpuStart);
      assert.deepEqual(actual, expected);
      if (run >= 3) {
        wall.push(elapsed);
        cpu.push((used.user + used.system) / 1000);
      }
    }
    console.log(JSON.stringify({ scenario, megabytes, refreshMedianMs: median(wall), cpuMedianMs: median(cpu), samples: wall.length }));
  }
  for (const megabytes of [1, 16, 64]) {
    const history = filler.repeat(Math.ceil(megabytes * 1024 * 1024 / Buffer.byteLength(filler)));
    await measure("reading-at-tail", megabytes, history + reading + "\n", expected);
    if (megabytes > 1) await measure("no-reading", megabytes, history, null);
  }
  await measure("one-long-record", 16, JSON.stringify({ ignored: "x".repeat(16 * 1024 * 1024), type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } }), expected);
} finally {
  await rm(home, { recursive: true, force: true });
}
