import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import type { UsagePrefs } from "@orquester/config";
import { UsageService } from "./usage";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 45 }, weekly: { percent: 69 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 3 }, weekly: { percent: 37 } };
const allOn: UsagePrefs = { enabled: true, claude: true, codex: true, chip: "busiest" };

function make(over: Partial<UsagePrefs> = {}, c: AgentUsage | null = claude) {
  const changed: unknown[] = [];
  let now = 1_000;
  const svc = new UsageService({
    fetchClaude: async () => c,
    readCodex: async () => codex,
    getPrefs: async () => ({ ...allOn, ...over }),
    now: () => now,
    activeMs: 60_000,
    idleMs: 300_000
  });
  svc.events.on("changed", (u) => changed.push(u));
  return { svc, changed, setNow: (n: number) => (now = n) };
}

const t = async () => {
  // Snapshot(force) computes; both agents present when enabled.
  const a = make();
  const snap = await a.svc.snapshot(true);
  assert.deepEqual(snap.agents.map((x) => x.id), ["claude", "codex"]);
  assert.equal(a.changed.length, 1); // emitted on first movement

  // Recompute with identical data does NOT re-emit (dedupe on agents payload).
  await a.svc.recompute();
  assert.equal(a.changed.length, 1);

  // Disabling an agent drops it and re-emits.
  const b = make({ codex: false });
  await b.svc.snapshot(true);
  const snapB = await b.svc.snapshot(false);
  assert.deepEqual(snapB.agents.map((x) => x.id), ["claude"]);

  // enabled=false ⇒ no agents at all.
  const c = make({ enabled: false });
  const snapC = await c.svc.snapshot(true);
  assert.equal(snapC.agents.length, 0);

  // A null claude source (not logged in) is simply omitted.
  const d = make({}, null);
  const snapD = await d.svc.snapshot(true);
  assert.deepEqual(snapD.agents.map((x) => x.id), ["codex"]);

  console.log("usage.check OK");
};
void t();
