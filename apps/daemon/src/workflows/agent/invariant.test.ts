// Property-style: random chains, random limit / auth schedules, random restarts — a usage limit or an
// auth failure NEVER fails the block while an eligible candidate remains, and the block lands on the
// first candidate (in fallback order) that can work.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAccount, AgentChainEntry } from "@orquester/api";
import type { NodeResult } from "../contracts.ts";
import type { AgentBlockOutput } from "./executor.ts";
import type { FakeTurnInfo, ProviderStep } from "./testing/fake-chat-host.ts";
import { account, agentNode, testWorkflow } from "./testing/fake-context.ts";
import { Scenario } from "./testing/scenario.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fate = "ok" | "start" | "atStart" | "mid" | "parked" | "background" | "auth" | "legacy";
const FAILURES: Fate[] = ["start", "atStart", "mid", "parked", "background", "auth", "legacy"];
const AGENTS = [
  { agent: "claude", model: "opus", family: "claude" as const, prefix: "k" },
  { agent: "codex", model: "gpt-5", family: "codex" as const, prefix: "x" },
  { agent: "grok", model: "grok-4", family: "grok" as const, prefix: "g" },
  { agent: "opencode", model: "oc/model", family: null, prefix: "o" }
];
const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;

function stepsFor(fate: Fate, text: string): ProviderStep[] {
  switch (fate) {
    case "ok":
      return [{ kind: "wait", ms: 1_000 }, { kind: "say", text }];
    case "start":
      return [{ kind: "limit" }];
    case "atStart":
      return [{ kind: "limit", atStart: true }];
    case "mid":
      return [{ kind: "say", text: "partial" }, { kind: "wait", ms: 7_000 }, { kind: "limit", resetsAt: "2026-09-28T20:00:00.000Z" }];
    case "parked":
      return [{ kind: "say", text: "partial" }, { kind: "limit", parked: true }];
    case "background":
      return [{ kind: "say", text: "spawned" }, { kind: "background", steps: [{ kind: "wait", ms: 12_000 }, { kind: "limit" }] }];
    case "auth":
      return [{ kind: "auth" }];
    case "legacy":
      return [{ kind: "limit", legacy: true }];
  }
}

test("random limit schedules never fail the block while an eligible candidate remains", async () => {
  const rand = mulberry32(20260928);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const tally = { succeeded: 0, burnt: 0, restarted: 0, hops: 0 };
  for (let trial = 0; trial < 60; trial += 1) {
    const entries = [...AGENTS].sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * 3));
    const accounts: AgentAccount[] = [];
    const fates = new Map<string, Fate>();
    const order: string[] = [];
    const chain: AgentChainEntry[] = [];
    for (const e of entries) {
      chain.push({ agent: e.agent, model: e.model, accounts: { ...FIXED } });
      if (e.family === null) {
        const key = `${e.agent}:system`;
        fates.set(key, rand() < 0.4 ? "ok" : pick(FAILURES.filter((f) => f !== "auth" && f !== "legacy")));
        order.push(key);
        continue;
      }
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 1; i <= n; i += 1) {
        const id = `${e.prefix}${i}`;
        accounts.push(account(e.family, id));
        // The legacy text fallback exists only for the prefixes Claude's and Grok's adapters wrote.
        const failures = e.agent === "claude" || e.agent === "grok" ? FAILURES : FAILURES.filter((f) => f !== "legacy");
        fates.set(`${e.agent}:${id}`, rand() < 0.3 ? "ok" : pick(failures));
        order.push(`${e.agent}:${id}`);
      }
    }
    const behaviour = (t: FakeTurnInfo): ProviderStep[] => {
      const key = `${t.refId}:${t.accountId}`;
      return stepsFor(fates.get(key) ?? "ok", `done by ${key}`);
    };
    const sc = new Scenario({ accounts, behaviour });
    const wf = testWorkflow([agentNode("n1", { chain })]);
    const crash = rand() < 0.5 ? { persist: 1 + Math.floor(rand() * 14) } : null;
    let result: NodeResult;
    if (crash) {
      const run = await sc.runWithRestart(wf, "n1", crash);
      result = run.result;
      if (run.crashed) tally.restarted += 1;
    } else {
      result = (await sc.run(wf, "n1")).result;
    }

    const winner = order.find((key) => fates.get(key) === "ok");
    const label = `trial ${trial}: chain ${chain.map((c) => c.agent).join("→")}, fates ${JSON.stringify([...fates])}, crash ${JSON.stringify(crash)}`;
    if (winner) {
      assert.equal(result.status, "succeeded", `${label}\n${JSON.stringify(result)}`);
      const out = (result as { output: AgentBlockOutput }).output;
      assert.equal(out.text, `done by ${winner}`, label);
      assert.equal(`${out.agent}:${out.accountId}`, winner, label);
      const tried = order.slice(0, order.indexOf(winner) + 1);
      assert.deepEqual(out.hops.map((h) => `${h.agent}:${h.accountId}`), tried, label);
      tally.succeeded += 1;
      tally.hops += out.hops.length - 1;
    } else {
      assert.equal(result.status, "failed", label);
      assert.equal((result as { error: { kind: string } }).error.kind, "all_burnt", label);
      tally.burnt += 1;
    }
  }
  // The schedules really exercised the loop: successes after failovers, exhausted chains, restarts.
  assert.ok(tally.succeeded >= 20 && tally.burnt >= 5 && tally.restarted >= 15 && tally.hops >= 20, JSON.stringify(tally));
});
