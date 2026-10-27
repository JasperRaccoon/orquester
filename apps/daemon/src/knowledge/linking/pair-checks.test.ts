import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeConceptRef } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import {
  harvestPairCheckInbox,
  KnowledgePairChecks,
  PAIR_CHECK_BODY_CHARS,
  PAIR_CHECK_STEP,
  pairCheckCandidates,
  pairCheckInput,
  parsePairCheckAnswer,
  validatePairCheckAnswer,
  writePairCheckTask
} from "./pair-checks.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orq-pair-checks-"));
  roots.push(root);
  return root;
}

const NOW = new Date("2026-10-27T12:00:00.000Z");

describe("pair-check answers", () => {
  it("accept exactly {verdict, note}; refuse anything else with a reason", () => {
    assert.equal(validatePairCheckAnswer({ verdict: "contradicts", note: "48h vs 72h." }), null);
    for (const bad of [
      [],
      "contradicts",
      { verdict: "maybe", note: "x" },
      { verdict: "consistent" },
      { verdict: "consistent", note: "" },
      { verdict: "consistent", note: "x".repeat(501) },
      { verdict: "consistent", note: "x", confidence: 0.9 }
    ]) {
      assert.equal(typeof validatePairCheckAnswer(bad), "string", JSON.stringify(bad));
    }
    assert.deepEqual(parsePairCheckAnswer('{"verdict":"unrelated","note":" Different topics. "}'), { verdict: "unrelated", note: "Different topics." });
    assert.equal(parsePairCheckAnswer("not json"), null);
    assert.equal(parsePairCheckAnswer('{"verdict":"no"}'), null);
  });
});

describe("KnowledgePairChecks (the port)", () => {
  it("records, persists and reloads checks; all/get show only current ones; onChange fires on add and on an edit that makes one stale", async () => {
    const root = await dir();
    const path = join(root, "pair-checks.json");
    const hashes: Record<string, string> = { ke_a: "ha", ke_b: "hb", ke_c: "hc" };
    const make = () => new KnowledgePairChecks({ path, hashOf: (id) => hashes[id] ?? null, now: () => NOW });
    const checks = make();
    await checks.load();
    let changes = 0;
    const off = checks.onChange(() => (changes += 1));
    // Given unsorted: stored sorted, with the hashes following their entries.
    await checks.record({ a: "ke_b", b: "ke_a", hashA: "hb", hashB: "ha" }, "contradicts", "48h vs 72h");
    await checks.record({ a: "ke_a", b: "ke_c", hashA: "ha", hashB: "hc" }, "consistent", "Same advice.");
    assert.equal(changes, 2);
    assert.deepEqual(checks.get("ke_b", "ke_a"), { a: "ke_a", b: "ke_b", verdict: "contradicts", note: "48h vs 72h", checkedAt: NOW.toISOString() });
    assert.equal(checks.all().length, 2);
    assert.ok(checks.isChecked({ a: "ke_a", b: "ke_b", hashA: "ha", hashB: "hb" }));

    // Entry c is edited: its check is stale (kept on disk until the pair is checked again).
    hashes.ke_c = "hc2";
    checks.entriesChanged(["ke_c"]);
    assert.equal(changes, 3);
    checks.entriesChanged(["ke_zzz"]);
    assert.equal(changes, 3, "no check involves it");
    assert.deepEqual(checks.all().map((c) => [c.a, c.b]), [["ke_a", "ke_b"]]);
    assert.equal(checks.get("ke_a", "ke_c"), null);
    assert.ok(!checks.isChecked({ a: "ke_a", b: "ke_c", hashA: "ha", hashB: "hc2" }));
    off();
    await checks.flush();

    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; checks: { a: string; hashA: string; hashB: string }[] };
    assert.equal(file.version, 1);
    assert.deepEqual(file.checks.map((c) => [c.a, c.hashA, c.hashB]), [["ke_a", "ha", "hb"], ["ke_a", "ha", "hc"]]);
    const reloaded = make();
    await reloaded.load();
    assert.equal(reloaded.all().length, 1);
  });

  it("keeps unknown fields and unreadable records on rewrite; never writes a newer file; moves an unparsable one aside", async () => {
    const root = await dir();
    const path = join(root, "pair-checks.json");
    const record = { a: "ke_a", b: "ke_b", hashA: "ha", hashB: "hb", verdict: "consistent", note: "n", checkedAt: "t", model: "m" };
    await writeFile(path, JSON.stringify({ version: 1, checks: [record, { broken: true }], extra: 1 }));
    const checks = new KnowledgePairChecks({ path, hashOf: (id) => ({ ke_a: "ha", ke_b: "hb", ke_c: "hc" })[id] ?? null, now: () => NOW });
    await checks.load();
    await checks.record({ a: "ke_a", b: "ke_b", hashA: "ha", hashB: "hb" }, "contradicts", "now they disagree");
    await checks.flush();
    const written = JSON.parse(await readFile(path, "utf8")) as { checks: Record<string, unknown>[]; extra: number };
    assert.equal(written.extra, 1);
    assert.deepEqual(written.checks[1], { broken: true });
    assert.equal(written.checks[0]!.model, "m", "the record's unknown field survives its update");
    assert.equal(written.checks[0]!.verdict, "contradicts");

    const newer = JSON.stringify({ version: 2, checks: [record] });
    await writeFile(path, newer);
    const readOnly = new KnowledgePairChecks({ path, hashOf: () => null, now: () => NOW });
    await readOnly.load();
    await readOnly.record({ a: "ke_a", b: "ke_c", hashA: "ha", hashB: "hc" }, "consistent", "x");
    await readOnly.flush();
    assert.equal(await readFile(path, "utf8"), newer);

    await writeFile(path, "{ not json");
    const fresh = new KnowledgePairChecks({ path, hashOf: () => null, now: () => NOW });
    await fresh.load();
    assert.deepEqual(fresh.all(), []);
    assert.ok((await readdir(root)).some((name) => name.startsWith("pair-checks.json.unreadable-")));
  });
});

describe("pair-check candidates", () => {
  const ref = (type: string, id: string): KnowledgeConceptRef => ({ id, type, name: id });
  function setup() {
    const index = new FakeVectorIndex(); // good = 0.5
    index.set("ke_a", axis(8, 0));
    index.set("ke_b", around(8, 0, 1, 0.9)); // close to a, shares a Tactic: a candidate
    index.set("ke_c", around(8, 0, 2, 0.8)); // close to a, shares only a Person: not one
    index.set("ke_d", axis(8, 5)); // far from a, but a contradicts edge joins them
    index.set("ke_e", around(8, 0, 3, 0.6)); // close to a, shares a Metric: a candidate, further
    const concepts: Record<string, KnowledgeConceptRef[]> = {
      ke_a: [ref("Tactic", "t1"), ref("Person", "p1"), ref("Metric", "m1"), ref("Tactic", "t-48h")],
      ke_b: [ref("Tactic", "t1")],
      ke_c: [ref("Person", "p1")],
      ke_d: [ref("Tactic", "t-72h")],
      ke_e: [ref("Metric", "m1")]
    };
    const view: KnowledgeLinkGraphView = {
      vectors: () => index,
      conceptsOf: (id) => concepts[id] ?? [],
      contradicting: (id) => (id === "t-48h" ? ["t-72h"] : id === "t-72h" ? ["t-48h"] : [])
    };
    return { view, hashOf: (id: string) => `h-${id}` };
  }

  it("close pairs sharing a claim-like concept, and pairs joined by `contradicts`, closest first; checked pairs and the limit are honoured", async () => {
    const { view, hashOf } = setup();
    const ids = ["ke_a", "ke_b", "ke_c", "ke_d", "ke_e"];
    const all = await pairCheckCandidates({ ids, view, hashOf, isChecked: () => false, limit: 30 });
    assert.deepEqual(
      all.map((c) => [c.a, c.b]),
      [
        ["ke_a", "ke_b"],
        ["ke_a", "ke_e"],
        ["ke_a", "ke_d"]
      ]
    );
    assert.deepEqual({ hashA: all[0]!.hashA, hashB: all[0]!.hashB }, { hashA: "h-ke_a", hashB: "h-ke_b" });
    const unchecked = await pairCheckCandidates({ ids, view, hashOf, isChecked: (p) => p.b === "ke_b", limit: 1 });
    assert.deepEqual(unchecked.map((c) => [c.a, c.b]), [["ke_a", "ke_e"]]);
  });
});

describe("the pair checks' inbox", () => {
  it("a task carries both trimmed entries and its pair; an answer left before a restart is recorded, every task file removed", async () => {
    const root = await dir();
    const pair = { a: "ke_a", b: "ke_b", hashA: "ha", hashB: "hb" };
    const long = "y".repeat(PAIR_CHECK_BODY_CHARS + 500);
    const input = pairCheckInput({ id: "ke_a", title: "Alt pages", body: "Wait 48 hours." }, { id: "ke_b", title: "Other", body: long });
    assert.match(input, /ENTRY A \(ke_a\)[\s\S]*Title: Alt pages[\s\S]*Wait 48 hours\.[\s\S]*ENTRY B \(ke_b\)/);
    assert.ok(!input.includes(long) && input.includes("[…]"), "bodies are trimmed");

    const answered = await writePairCheckTask(root, pair, { a: { id: "ke_a", title: "A", body: "x" }, b: { id: "ke_b", title: "B", body: "y" } }, NOW);
    const open = await writePairCheckTask(root, { ...pair, b: "ke_c" }, { a: { id: "ke_a", title: "A", body: "x" }, b: { id: "ke_c", title: "C", body: "z" } }, NOW);
    const task = JSON.parse(await readFile(join(root, "agent_inbox", `${answered}.task.json`), "utf8")) as Record<string, unknown>;
    assert.equal(task.step, PAIR_CHECK_STEP);
    assert.deepEqual(task.pair, pair);
    await writeFile(join(root, "agent_outbox", `${answered}.answer.json`), JSON.stringify({ task_id: answered, answer: '{"verdict":"contradicts","note":"48h vs 72h"}' }));
    await writeFile(join(root, "agent_outbox", `${answered}.done`), "");

    const recorded: unknown[] = [];
    const count = await harvestPairCheckInbox(root, { record: async (...args) => void recorded.push(args) });
    assert.equal(count, 1);
    assert.deepEqual(recorded, [[pair, "contradicts", "48h vs 72h"]]);
    assert.deepEqual(await readdir(join(root, "agent_inbox")), [], `the open task (${open.slice(0, 8)}) goes too: written again while still worth checking`);
    assert.deepEqual(await readdir(join(root, "agent_outbox")), []);
    assert.equal(await harvestPairCheckInbox(join(root, "missing"), { record: async () => undefined }), 0);
  });
});
