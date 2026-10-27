import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeConceptRef } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import {
  negatedNames,
  harvestPairCheckInbox,
  KnowledgePairChecks,
  PAIR_CHECK_BODY_CHARS,
  PAIR_CHECK_STEP,
  pairCheckCandidates,
  pairCheckInput,
  parsePairCheckAnswer,
  validatePairCheckAnswer,
  writePairCheckTask,
  writeRoundTask
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

  it("pairs joined by `contradicts` first (whatever their similarity), then close pairs sharing a claim-like concept, closest first; checked pairs and the limit are honoured", async () => {
    const { view, hashOf } = setup();
    const ids = ["ke_a", "ke_b", "ke_c", "ke_d", "ke_e"];
    const all = await pairCheckCandidates({ ids, view, hashOf, isChecked: () => false, limit: 30 });
    assert.deepEqual(
      all.map((c) => [c.a, c.b, c.reason]),
      [
        ["ke_a", "ke_d", "contradicts"],
        ["ke_a", "ke_b", "shared"],
        ["ke_a", "ke_e", "shared"]
      ]
    );
    assert.deepEqual({ hashA: all[1]!.hashA, hashB: all[1]!.hashB }, { hashA: "h-ke_a", hashB: "h-ke_b" });
    const unchecked = await pairCheckCandidates({ ids, view, hashOf, isChecked: (p) => p.b !== "ke_e", limit: 1 });
    assert.deepEqual(unchecked.map((c) => [c.a, c.b]), [["ke_a", "ke_e"]]);
    const capped = await pairCheckCandidates({ ids, view, hashOf, isChecked: () => false, limit: 2 });
    assert.deepEqual(capped.map((c) => c.reason), ["contradicts", "shared"], "the cap keeps the first tiers");
  });

  it("meta entries: a synthesis is never checked; an entry linked to both sides of a `contradicts` edge is not paired through it", async () => {
    const { view, hashOf } = setup();
    const quoting: KnowledgeConceptRef[] = [ref("Tactic", "t-48h"), ref("Tactic", "t-72h"), ref("Tactic", "t1")];
    const index = view.vectors() as FakeVectorIndex;
    index.set("ke_q", around(8, 0, 4, 0.95));
    index.set("ke_s", around(8, 0, 5, 0.95));
    const meta: KnowledgeLinkGraphView = {
      ...view,
      conceptsOf: (id) => (id === "ke_q" ? quoting : id === "ke_s" ? [ref("Tactic", "t1"), ref("Tactic", "t-72h")] : view.conceptsOf(id))
    };
    const kinds: Record<string, string> = { ke_s: "synthesis" };
    const all = await pairCheckCandidates({
      ids: ["ke_a", "ke_b", "ke_d", "ke_q", "ke_s"],
      view: meta,
      hashOf,
      isChecked: () => false,
      limit: 30,
      entryOf: (id) => ({ kind: kinds[id] ?? "note", author: null, handle: null })
    });
    assert.ok(all.every((c) => c.a !== "ke_s" && c.b !== "ke_s"), JSON.stringify(all));
    // A note titled as a map, audit, hub or index surveys others, like a synthesis (`isSurveyEntry`).
    const titled = await pairCheckCandidates({
      ids: ["ke_a", "ke_b", "ke_d", "ke_q", "ke_s"],
      view: meta,
      hashOf,
      isChecked: () => false,
      limit: 30,
      entryOf: (id) =>
        id === "ke_s"
          ? { kind: "research note", title: "Claims audit / stale-tip register", author: null, handle: null }
          : id === "ke_q"
            ? { kind: "note", title: "Map of the knowledge base (hub)", author: null, handle: null }
            : { kind: "post", title: "Index your site with IndexNow", author: null, handle: null }
    });
    assert.deepEqual(titled.map((c) => [c.a, c.b, c.reason]), [
      ["ke_a", "ke_d", "contradicts"],
      ["ke_a", "ke_b", "shared"]
    ]);
    assert.deepEqual(
      all.map((c) => [c.a, c.b, c.reason]),
      [
        ["ke_a", "ke_d", "contradicts"],
        ["ke_a", "ke_q", "shared"],
        ["ke_a", "ke_b", "shared"],
        ["ke_b", "ke_q", "shared"]
      ],
      "ke_q quotes both sides: never paired through that edge, still through a shared claim"
    );
  });

  it("a negated name: one negates, the rest overlaps; parentheses are clarifications", () => {
    assert.equal(negatedNames("One trial per IP", "Use IP reputation as an input, never one-trial-per-IP"), true, "a live pair");
    assert.equal(negatedNames("Post daily", "Never post at night on weekends"), false, "too little in common");
    assert.equal(negatedNames("One trial per IP", "Never one trial per IP"), true);
    assert.equal(negatedNames("Offer a free trial", "Do not offer a free trial"), true);
    assert.equal(negatedNames("Allow OAI-SearchBot", "Allow OAI-SearchBot (and don't block it at the CDN)"), false);
    assert.equal(negatedNames("Avoid free VPNs", "Never use free VPNs"), false, "both negate");
  });

  it("opposite advice: a concept and its negation; different values for the same decision between near neighbours by different authors", async () => {
    const index = new FakeVectorIndex(); // good = 0.5
    index.set("ke_trial", axis(16, 0));
    index.set("ke_never", around(16, 0, 1, 0.7)); // "never one trial per IP"
    index.set("ke_outlook", axis(16, 4));
    index.set("ke_gmail", around(16, 4, 5, 0.9)); // nearest of ke_outlook, another author
    index.set("ke_gmail2", around(16, 4, 6, 0.85)); // also near, but the same author as ke_outlook
    index.set("ke_far", around(16, 4, 7, 0.55)); // close enough, but neither is among the other's nearest
    for (let i = 0; i < 6; i += 1) index.set(`ke_fill${i}`, around(16, 7, 8 + i, 0.95 - i * 0.01)); // ke_far's nearest
    for (let i = 0; i < 6; i += 1) index.set(`ke_near${i}`, around(16, 4, 14, 0.8)); // ke_outlook's nearest after its two
    const concepts: Record<string, KnowledgeConceptRef[]> = {
      ke_trial: [{ id: "t-one", type: "Tactic", name: "One trial per IP" }],
      ke_never: [{ id: "t-never", type: "Tactic", name: "Never one-trial-per-IP" }],
      ke_outlook: [{ id: "t-outlook", type: "Tactic", name: "Outlook/Proton email for TikTok account" }],
      ke_gmail: [{ id: "t-gmail", type: "Tactic", name: "Create TikTok accounts with a fresh Gmail" }],
      ke_gmail2: [{ id: "t-gmail2", type: "Tactic", name: "Create a TikTok account with Gmail" }],
      ke_far: [{ id: "t-far", type: "Tactic", name: "TikTok account email choice" }]
    };
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: (id) => concepts[id] ?? [], contradicting: () => [] };
    const authors: Record<string, [string, string | null]> = { ke_outlook: ["jason", null], ke_gmail: ["Alex", null], ke_gmail2: ["Alex", "@Jason "] };
    const all = await pairCheckCandidates({
      ids: [...index.embeddedIds()],
      view,
      hashOf: (id) => `h-${id}`,
      isChecked: () => false,
      limit: 30,
      entryOf: (id) => ({ kind: "post", author: authors[id]?.[0] ?? id, handle: authors[id]?.[1] ?? null })
    });
    assert.deepEqual(
      all.map((c) => [c.a, c.b, c.reason]),
      [
        ["ke_never", "ke_trial", "negation"],
        ["ke_gmail", "ke_outlook", "alternatives"]
      ]
    );
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

  it("a round task source's task carries its payload; an answer left before a restart goes to its source only if it validates", async () => {
    const root = await dir();
    const good = await writeRoundTask(root, "cluster-name", { label: "cluster-name k1", system: "S", user: "U1", payload: { key: "k1" } }, NOW);
    const bad = await writeRoundTask(root, "cluster-name", { label: "cluster-name k2", system: "S", user: "U2", payload: { key: "k2" } }, NOW);
    const orphan = await writeRoundTask(root, "unknown-step", { label: "x", system: "S", user: "U3", payload: 1 }, NOW);
    const task = JSON.parse(await readFile(join(root, "agent_inbox", `${good}.task.json`), "utf8")) as Record<string, unknown>;
    assert.equal(task.step, "cluster-name");
    assert.deepEqual(task.payload, { key: "k1" });
    for (const [id, answer] of [[good, '{"label":"App Store review"}'], [bad, '{"label":""}'], [orphan, "{}"]] as const) {
      await writeFile(join(root, "agent_outbox", `${id}.answer.json`), JSON.stringify({ task_id: id, answer }));
      await writeFile(join(root, "agent_outbox", `${id}.done`), "");
    }
    const recorded: unknown[] = [];
    const source = {
      validate: (value: unknown) => ((value as { label?: unknown }).label ? null : "a label"),
      record: async (payload: unknown, answer: string) => void recorded.push([payload, answer])
    };
    const count = await harvestPairCheckInbox(root, { record: async () => undefined }, new Map([["cluster-name", source]]));
    assert.equal(count, 1);
    assert.deepEqual(recorded, [[{ key: "k1" }, '{"label":"App Store review"}']]);
    assert.deepEqual(await readdir(join(root, "agent_inbox")), []);
  });
});
