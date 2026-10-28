import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeConceptRef } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import {
  GMAIL_PASSAGE,
  LONG_GUIDE,
  LONG_GUIDE_CONCEPTS,
  NORDVPN_GUIDE,
  NORDVPN_WARNING,
  SHORT_GUIDE,
  SHORT_GUIDE_CONCEPTS,
  VPN_DETECTION
} from "./fixtures/tiktok-guides.ts";
import {
  claimNumbers,
  negatedNames,
  numbersOnlyDiffer,
  type PairCheckEntryInfo,
  harvestPairCheckInbox,
  KnowledgePairChecks,
  PAIR_CHECK_BODY_CHARS,
  PAIR_CHECK_INPUT_VERSION,
  PAIR_CHECK_MAX_PER_RUN,
  PAIR_CHECK_STEP,
  PAIR_CHECK_SYSTEM,
  PAIR_CHECK_V1_BODY_CHARS,
  pairCheckItemKey,
  pairCheckNeedsRecheck,
  ROUND_TASK_MAX_ATTEMPTS,
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

  it("the prompt counts only the claims each entry itself makes, and asks for whole notes of at most 400 characters", () => {
    // A live false positive: a research note that quotes and agrees with Alex's guide was judged to
    // contradict it over a tension inside the guide itself.
    assert.match(PAIR_CHECK_SYSTEM, /Only the claims each entry itself makes count/);
    assert.match(PAIR_CHECK_SYSTEM, /quotes, cites, summarises or agrees with the other[^\n]*do not contradict each other on that point/);
    assert.match(PAIR_CHECK_SYSTEM, /Tension inside one entry[^\n]*is not a contradiction between the two entries/);
    assert.match(PAIR_CHECK_SYSTEM, /research note that qualifies, refines[^\n]*is consistent with it, unless it states that the post's claim is wrong/);
    assert.match(PAIR_CHECK_SYSTEM, /one or two complete sentences of at most 400 characters that state each side's claim/);
    assert.equal(validatePairCheckAnswer({ verdict: "contradicts", note: "x".repeat(400) }), null);
    assert.match(validatePairCheckAnswer({ verdict: "contradicts", note: "x".repeat(401) }) ?? "", /at most 400 characters/);
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

describe("round task attempts", () => {
  it("an item without an acceptable answer in three rounds is given up on, persisted and read back; an answer forgets its failures", async () => {
    const root = await dir();
    const path = join(root, "pair-checks.json");
    let now = NOW;
    const checks = new KnowledgePairChecks({ path, hashOf: () => null, now: () => now });
    await checks.load();
    const item = { key: pairCheckItemKey({ a: "ke_b", b: "ke_a", hashA: "hb", hashB: "ha" }), step: PAIR_CHECK_STEP, label: "pair-check ke_a ke_b" };
    assert.equal(item.key, "pair ke_a ke_b ha hb", "the pair sorted, with its hashes");
    for (let round = 1; round < ROUND_TASK_MAX_ATTEMPTS; round += 1) {
      assert.equal(await checks.failedAttempt(item), false);
      assert.equal(checks.gaveUp(item.key), false);
    }
    now = new Date("2026-10-27T12:00:00.000Z");
    assert.equal(await checks.failedAttempt(item), true);
    assert.equal(checks.gaveUp(item.key), true);
    await checks.failedAttempt({ key: "other", step: "cluster-name", label: "cluster-name k" });
    await checks.flush();
    const reread = new KnowledgePairChecks({ path, hashOf: () => null, now: () => now });
    await reread.load();
    assert.equal(reread.gaveUp(item.key), true);
    assert.equal(reread.gaveUp("other"), false);
    await reread.answered("other");
    await reread.flush();
    const written = JSON.parse(await readFile(path, "utf8")) as { attempts: { key: string; failures: number; gaveUpAt: string | null }[] };
    assert.deepEqual(written.attempts.map((r) => [r.key, r.failures, r.gaveUpAt]), [[item.key, 3, "2026-10-27T12:00:00.000Z"]]);
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
    assert.deepEqual(all[0]!.focus.map((c) => c.id), ["t-48h", "t-72h"], "the ends of the edge, the passages shown first");
    assert.deepEqual(all[1]!.focus, [], "a shared claim has no focus");
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
    assert.deepEqual(
      all.map((c) => c.focus.map((concept) => concept.id).sort()),
      [
        ["t-never", "t-one"],
        ["t-gmail", "t-outlook"]
      ],
      "the concept and its negation; the two values"
    );
  });

  it("opposite advice in the text: saved posts by different authors that name one Tool, one against it and the other using it", async () => {
    const posts = [NORDVPN_GUIDE, NORDVPN_WARNING, VPN_DETECTION];
    // A research note that repeats the warning: it reports, it is not a saved post taking a side.
    const research = { ...NORDVPN_WARNING, id: "ke_research", author: "Claude (research)" };
    const index = new FakeVectorIndex(); // good = 0.5
    [...posts, research].forEach((entry, i) => index.set(entry.id, around(16, 0, 1 + i, 0.9 - i * 0.01)));
    const all = [...posts, research];
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: (id) => all.find((e) => e.id === id)?.concepts ?? [], contradicting: () => [] };
    const options = {
      ids: all.map((e) => e.id),
      view,
      hashOf: (id: string) => `h-${id}`,
      isChecked: () => false,
      limit: 30,
      entryOf: (id: string) => {
        const entry = all.find((e) => e.id === id)!;
        return { kind: entry === research ? "research note" : "post", title: entry.title, author: entry.author, handle: null };
      },
      bodyOf: async (id: string) => all.find((e) => e.id === id)?.body ?? null
    };
    const found = await pairCheckCandidates(options);
    const opposed = found.filter((c) => c.reason === "opposed");
    assert.deepEqual(
      opposed.map((c) => [c.a, c.b]).sort(),
      [
        [NORDVPN_GUIDE.id, VPN_DETECTION.id], // "install a VPN" / "tiktok knows you're using a vpn"
        [NORDVPN_GUIDE.id, NORDVPN_WARNING.id], // "I use NordVPN" / "do not use NordVPN"
        [VPN_DETECTION.id, NORDVPN_WARNING.id] // "tiktok knows you're using a vpn" / "host your own VPN"
      ].map((pair) => pair.sort()).sort()
    );
    assert.equal(found.indexOf(opposed[0]!), 0, "the opposed tier comes before alternatives and shared claims");
    const nord = opposed.find((c) => [c.a, c.b].includes(NORDVPN_GUIDE.id) && [c.a, c.b].includes(NORDVPN_WARNING.id))!;
    assert.deepEqual(nord.focus.map((c) => c.id), ["tool-nordvpn"], "the Tool both name: its passages are shown first");
    assert.ok(found.every((c) => c.reason !== "opposed" || (c.a !== research.id && c.b !== research.id)), "a research note is no side of opposite advice");
    // Without the bodies, nothing is found that way.
    const { bodyOf: _bodyOf, ...withoutBodies } = options;
    assert.ok((await pairCheckCandidates(withoutBodies)).every((c) => c.reason !== "opposed"));
  });

  it("within a tier: saved posts by different authors first, then a note on one side, one author's own entries last", async () => {
    const index = new FakeVectorIndex(); // good = 0.5
    index.set("ke_r1", around(16, 0, 1, 0.99));
    index.set("ke_r2", around(16, 0, 2, 0.99)); // the closest pair: one research agent's two notes
    index.set("ke_p1", around(16, 0, 3, 0.8));
    index.set("ke_p2", around(16, 0, 4, 0.8)); // the furthest pair: two posts by different authors
    const shared = [{ id: "t-warm", type: "Tactic", name: "Warm up the account" }];
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: () => shared, contradicting: () => [] };
    const info: Record<string, PairCheckEntryInfo> = {
      ke_r1: { kind: "research note", author: "Claude (research)", handle: null },
      ke_r2: { kind: "research note", author: "Claude (research)", handle: null },
      ke_p1: { kind: "post", author: "jason", handle: null },
      ke_p2: { kind: "thread", author: "Alex Nguyen", handle: null }
    };
    const found = await pairCheckCandidates({ ids: Object.keys(info), view, hashOf: (id) => `h-${id}`, isChecked: () => false, limit: 30, entryOf: (id) => info[id] ?? null });
    assert.ok(found.every((c) => c.reason === "shared"));
    assert.deepEqual(found[0] && [found[0].a, found[0].b], ["ke_p1", "ke_p2"]);
    assert.deepEqual(found.at(-1) && [found.at(-1)!.a, found.at(-1)!.b], ["ke_r1", "ke_r2"]);
    assert.equal(found.length, 6);
  });
});

describe("the task's input: excerpts chosen for relevance", () => {
  const short = { ...SHORT_GUIDE, concepts: SHORT_GUIDE_CONCEPTS };
  const long = { ...LONG_GUIDE, concepts: LONG_GUIDE_CONCEPTS };

  it("a long body deep inside which the disagreement sits: the passage is in the prompt, said to be excerpts; a short body is whole", () => {
    assert.ok(LONG_GUIDE.body.length > PAIR_CHECK_BODY_CHARS && SHORT_GUIDE.body.length <= PAIR_CHECK_BODY_CHARS);
    assert.ok(LONG_GUIDE.body.indexOf(GMAIL_PASSAGE) > PAIR_CHECK_BODY_CHARS, "past what any opening-only cut would show");
    const input = pairCheckInput(short, long);
    assert.ok(input.includes(SHORT_GUIDE.body), "the short guide whole");
    assert.ok(input.includes("11) make an outlook/proton email"));
    assert.ok(input.includes(GMAIL_PASSAGE), "the Gmail passage of the long guide");
    assert.match(input, /SECOND ENTRY \(ke_mq74jvvzggnn\)\n=+\nTitle: Step-by-step iPhone setup[^\n]*\nAuthor: [^\n]*\nName it in the note as: [^\n]*\n\(Excerpts chosen for relevance to the other entry[^\n]*\)\n\nStep-by-step phone setup/);
    assert.ok(!/FIRST ENTRY[^]*\(Excerpts chosen[^]*SECOND ENTRY/.test(input), "a whole body is not called excerpts");
    assert.match(input, /A disagreement in any excerpt counts\./);
    assert.match(PAIR_CHECK_SYSTEM, /passages chosen for their relevance to the other entry/);
    assert.match(PAIR_CHECK_SYSTEM, /A disagreement in any excerpt counts/);
    // The same either way round, and the same every time.
    assert.ok(pairCheckInput(long, short).includes(GMAIL_PASSAGE));
    assert.equal(pairCheckInput(short, long), input);
  });

  it("the focus concepts' passages come first", () => {
    // Lines sharing many words with the short guide fill the budget; one line shares none of its
    // words but names the concept the pair was found through.
    const lines = Array.from({ length: 40 }, (_, i) => `Proxy note ${i}: buy an isp proxy at iproyal, set socks5 in shadowrocket, check ipqualityscore and scamalytics, warm up 48 hours.`);
    lines.splice(25, 0, "Static note: a paid dedicated static VPN gets configured once.");
    const other = { id: "ke_other", title: "Proxy notes", body: lines.join("\n"), concepts: [] };
    const focus = [{ id: "t-static", type: "Tactic", name: "Paid dedicated static VPN" }];
    assert.ok(!pairCheckInput(short, other).includes("Static note"));
    assert.ok(pairCheckInput(short, other, focus).includes("Static note: a paid dedicated static VPN gets configured once."));
  });
});

describe("re-asking checks judged on cut text", () => {
  const long = (id: string) => id === "ke_long" || id === "ke_long2";
  it("a consistent or unrelated verdict on input version 1 with a body past the old cut is asked again; short bodies and later versions stand", () => {
    const base = { a: "ke_long", b: "ke_short" };
    assert.equal(pairCheckNeedsRecheck({ ...base, verdict: "consistent" }, long), true);
    assert.equal(pairCheckNeedsRecheck({ ...base, verdict: "unrelated", inputVersion: 1 }, long), true);
    assert.equal(pairCheckNeedsRecheck({ a: "ke_short", b: "ke_long", verdict: "unrelated" }, long), true, "either side");
    assert.equal(pairCheckNeedsRecheck({ a: "ke_short", b: "ke_short2", verdict: "consistent" }, long), false, "both whole: nothing was cut");
    assert.equal(pairCheckNeedsRecheck({ ...base, verdict: "consistent", inputVersion: 2 }, long), false);
    assert.equal(pairCheckNeedsRecheck({ ...base, verdict: "unrelated", inputVersion: PAIR_CHECK_INPUT_VERSION }, long), false);
  });

  it("every contradicts verdict asked before version 4 is asked again once under the current prompt; consistent and unrelated version-2 verdicts stand", async () => {
    assert.equal(PAIR_CHECK_INPUT_VERSION, 4);
    const short = () => false;
    for (const inputVersion of [undefined, 1, 2, 3]) {
      assert.equal(pairCheckNeedsRecheck({ a: "ke_a", b: "ke_b", verdict: "contradicts", ...(inputVersion ? { inputVersion } : {}) }, short), true, `contradicts on ${inputVersion ?? "no"} version`);
    }
    for (const verdict of ["consistent", "unrelated"] as const) assert.equal(pairCheckNeedsRecheck({ a: "ke_a", b: "ke_b", verdict, inputVersion: 2 }, short), false, verdict);

    const root = await dir();
    const path = join(root, "pair-checks.json");
    const hashOf = (id: string) => `h-${id}`;
    const v2 = (a: string, b: string, verdict: string) => ({ a, b, hashA: hashOf(a), hashB: hashOf(b), verdict, note: "n", checkedAt: "t", inputVersion: 2 });
    await writeFile(path, JSON.stringify({ version: 1, checks: [v2("ke_a", "ke_b", "contradicts"), v2("ke_a", "ke_c", "consistent"), v2("ke_b", "ke_c", "unrelated")] }));
    const checks = new KnowledgePairChecks({ path, hashOf, now: () => NOW });
    await checks.load();
    const pair = (a: string, b: string) => ({ a, b, hashA: hashOf(a), hashB: hashOf(b) });
    const index = new FakeVectorIndex(); // good = 0.5
    for (const [i, id] of ["ke_a", "ke_b", "ke_c"].entries()) index.set(id, around(8, 0, 1 + i, 0.9));
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: () => [{ id: "t", type: "Tactic", name: "Warm up" }], contradicting: () => [] };
    const round = await pairCheckCandidates({ ids: ["ke_a", "ke_b", "ke_c"], view, hashOf, isChecked: (p) => checks.isChecked(p, short), limit: 30 });
    assert.deepEqual(round.map((c) => [c.a, c.b]), [["ke_a", "ke_b"]], "only the contradicts verdict is asked again");
    assert.equal(checks.get("ke_a", "ke_b")?.verdict, "contradicts", "it shows until the new answer replaces it");
    await checks.record(pair("ke_a", "ke_b"), "consistent", "B quotes A's guide and agrees with it.");
    assert.equal(checks.isChecked(pair("ke_a", "ke_b"), short), true, "asked once");
  });

  it("the pair is a candidate again once: its new check is recorded on the current version; bounded by the round's limit, tiers first", async () => {
    const root = await dir();
    const path = join(root, "pair-checks.json");
    const hashOf = (id: string) => `h-${id}`;
    const v1 = (a: string, b: string, verdict: string) => ({ a, b, hashA: hashOf(a), hashB: hashOf(b), verdict, note: "n", checkedAt: "t" });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        checks: [v1("ke_long", "ke_short", "consistent"), { ...v1("ke_long2", "ke_short", "contradicts"), inputVersion: 3 }, v1("ke_short", "ke_short2", "unrelated"), { ...v1("ke_long", "ke_long2", "consistent"), inputVersion: 2 }]
      })
    );
    const checks = new KnowledgePairChecks({ path, hashOf, now: () => NOW });
    await checks.load();
    assert.deepEqual(checks.recheckEntryIds(), ["ke_long", "ke_long2", "ke_short", "ke_short2"], "the entries of version-1 consistent/unrelated checks and of the version-3 contradicts");
    const pair = { a: "ke_long", b: "ke_short", hashA: hashOf("ke_long"), hashB: hashOf("ke_short") };
    assert.equal(checks.isChecked(pair), true, "without body lengths: checked, as before");
    assert.equal(checks.isChecked(pair, long), false, "asked again");
    assert.equal(checks.isChecked({ ...pair, b: "ke_long2", hashB: hashOf("ke_long2") }, long), true, "version 2");
    assert.equal(checks.isChecked({ a: "ke_long2", b: "ke_short", hashA: hashOf("ke_long2"), hashB: hashOf("ke_short") }, long), false, "a version-3 contradicts is asked again (its note calls the sides A and B)");
    assert.equal(checks.isChecked({ a: "ke_short", b: "ke_short2", hashA: hashOf("ke_short"), hashB: hashOf("ke_short2") }, long), true, "nothing was cut");
    assert.equal(checks.get("ke_long", "ke_short")?.verdict, "consistent", "the old verdict shows until it is replaced");

    await checks.record(pair, "contradicts", "Gmail vs Outlook/Proton.");
    assert.equal(checks.isChecked(pair, long), true, "asked once");
    await checks.flush();
    const written = JSON.parse(await readFile(path, "utf8")) as { checks: Record<string, unknown>[] };
    assert.equal(written.checks.find((c) => c.a === "ke_long" && c.b === "ke_short")!.inputVersion, PAIR_CHECK_INPUT_VERSION);
    const reread = new KnowledgePairChecks({ path, hashOf, now: () => NOW });
    await reread.load();
    assert.equal(reread.isChecked(pair, long), true, "and after a restart");
    assert.ok(PAIR_CHECK_V1_BODY_CHARS < PAIR_CHECK_BODY_CHARS);
  });

  it("re-asks go through the candidates like new pairs: their tier order and the round's limit", async () => {
    const index = new FakeVectorIndex(); // good = 0.5
    const concepts: Record<string, KnowledgeConceptRef[]> = {};
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `ke_${String(i).padStart(2, "0")}`;
      ids.push(id);
      index.set(id, around(16, 0, 1 + i, 0.9));
      concepts[id] = [{ id: "t-shared", type: "Tactic", name: "Shared tactic" }, ...(i === 11 ? [{ id: "t-48h", type: "Tactic", name: "48h" }] : i === 10 ? [{ id: "t-72h", type: "Tactic", name: "72h" }] : [])];
    }
    const view: KnowledgeLinkGraphView = {
      vectors: () => index,
      conceptsOf: (id) => concepts[id] ?? [],
      contradicting: (id) => (id === "t-48h" ? ["t-72h"] : id === "t-72h" ? ["t-48h"] : [])
    };
    const hashOf = (id: string) => `h-${id}`;
    const root = await dir();
    const path = join(root, "pair-checks.json");
    // Every pair was checked on version 1 and found consistent; every body is long.
    const records = [];
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) records.push({ a: ids[i], b: ids[j], hashA: hashOf(ids[i]!), hashB: hashOf(ids[j]!), verdict: "consistent", note: "n", checkedAt: "t" });
    await writeFile(path, JSON.stringify({ version: 1, checks: records }));
    const checks = new KnowledgePairChecks({ path, hashOf, now: () => NOW });
    await checks.load();
    const round = await pairCheckCandidates({ ids, view, hashOf, isChecked: (p) => checks.isChecked(p, () => true), limit: PAIR_CHECK_MAX_PER_RUN });
    assert.equal(round.length, PAIR_CHECK_MAX_PER_RUN, `${records.length} re-asks, ${PAIR_CHECK_MAX_PER_RUN} a round`);
    assert.deepEqual([round[0]!.a, round[0]!.b, round[0]!.reason], ["ke_10", "ke_11", "contradicts"], "the contradicts tier first");
    assert.equal(
      (await pairCheckCandidates({ ids, view, hashOf, isChecked: (p) => checks.isChecked(p), limit: PAIR_CHECK_MAX_PER_RUN })).length,
      0,
      "without the rule: nothing to ask"
    );
  });
});

describe("the pair checks' inbox", () => {
  it("a task carries both trimmed entries and its pair; an answer left before a restart is recorded, every task file removed", async () => {
    const root = await dir();
    const pair = { a: "ke_a", b: "ke_b", hashA: "ha", hashB: "hb" };
    const long = "y".repeat(PAIR_CHECK_BODY_CHARS + 500);
    const input = pairCheckInput({ id: "ke_a", title: "Alt pages", body: "Wait 48 hours." }, { id: "ke_b", title: "Other", body: long });
    assert.match(input, /FIRST ENTRY \(ke_a\)[\s\S]*Title: Alt pages[\s\S]*Wait 48 hours\.[\s\S]*SECOND ENTRY \(ke_b\)/);
    assert.ok(!input.includes(long) && input.includes("[…]"), "bodies are trimmed");

    const answered = await writePairCheckTask(root, pair, { a: { id: "ke_a", title: "A", body: "x" }, b: { id: "ke_b", title: "B", body: "y" } }, NOW);
    const open = await writePairCheckTask(root, { ...pair, b: "ke_c" }, { a: { id: "ke_a", title: "A", body: "x" }, b: { id: "ke_c", title: "C", body: "z" } }, NOW);
    const task = JSON.parse(await readFile(join(root, "agent_inbox", `${answered}.task.json`), "utf8")) as Record<string, unknown>;
    assert.equal(task.step, PAIR_CHECK_STEP);
    assert.deepEqual(task.pair, pair);
    assert.equal(task.inputVersion, PAIR_CHECK_INPUT_VERSION);
    await writeFile(join(root, "agent_outbox", `${answered}.answer.json`), JSON.stringify({ task_id: answered, answer: '{"verdict":"contradicts","note":"48h vs 72h"}' }));
    await writeFile(join(root, "agent_outbox", `${answered}.done`), "");
    // A task an older build wrote (no input version) and answered before the restart: version 1.
    const legacy = { a: "ke_a", b: "ke_d", hashA: "ha", hashB: "hd" };
    await writeFile(
      join(root, "agent_inbox", "legacy.task.json"),
      JSON.stringify({ task_id: "legacy", step: PAIR_CHECK_STEP, context_label: "pair-check ke_a ke_d", system: "S", user: "U", max_tokens: 1024, timeout_seconds: 0, created_at: NOW.toISOString(), pair: legacy })
    );
    await writeFile(join(root, "agent_outbox", "legacy.answer.json"), JSON.stringify({ task_id: "legacy", answer: '{"verdict":"consistent","note":"Same."}' }));
    await writeFile(join(root, "agent_outbox", "legacy.done"), "");

    const recorded: unknown[] = [];
    const count = await harvestPairCheckInbox(root, { record: async (...args) => void recorded.push(args) });
    assert.equal(count, 2);
    assert.deepEqual(
      recorded.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      [
        [pair, "contradicts", "48h vs 72h", PAIR_CHECK_INPUT_VERSION],
        [legacy, "consistent", "Same.", 1]
      ]
    );
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

describe("input version 4: notes name each side", () => {
  it("the input shows each side's author (handle, else a short title) and the name to call it by; the prompt forbids A and B", () => {
    const input = pairCheckInput(
      { id: "ke_a", title: "Make any phone hit a US audience on TikTok", body: "warm it up for 48 hours", author: "jason", handle: "jasonugc" },
      { id: "ke_b", title: "Step-by-step iPhone setup: TikTok", body: "post after 1-2 days", author: null, handle: "@alexn" }
    );
    assert.match(input, /FIRST ENTRY \(ke_a\)\n=+\nTitle: [^\n]*\nAuthor: jason @jasonugc\nName it in the note as: jason\n/);
    assert.match(input, /SECOND ENTRY \(ke_b\)\n=+\nTitle: [^\n]*\nAuthor: @alexn\nName it in the note as: @alexn\n/);
    assert.match(input, /never "A" or "B"/);
    const same = pairCheckInput({ id: "ke_a", title: "First note: on warm-up", body: "x", author: "Claude" }, { id: "ke_b", title: "Second note", body: "y", author: "claude" });
    assert.match(same, /Name it in the note as: “First note”\n[\s\S]*Name it in the note as: “Second note”\n/, "the same author on both sides: short titles");
    assert.match(PAIR_CHECK_SYSTEM, /call each side by the name shown for it/);
    assert.match(PAIR_CHECK_SYSTEM, /Never call them A and B/);
    assert.match(PAIR_CHECK_SYSTEM, /different number, duration, quantity or limit for the same step/);
  });

  it("an answer whose note calls the sides A and B is refused, so the worker answers again", () => {
    assert.equal(typeof validatePairCheckAnswer({ verdict: "contradicts", note: "A says 48 hours. B says 5-7 days." }), "string");
    assert.equal(typeof validatePairCheckAnswer({ verdict: "contradicts", note: "Both target the US, but A recommends a proxy while B says to self-host." }), "string");
    assert.equal(validatePairCheckAnswer({ verdict: "contradicts", note: "jason says to warm up for 48 hours; Ema Totaro says 5-7 days." }), null);
    assert.equal(validatePairCheckAnswer({ verdict: "consistent", note: "Both run A/B tests on the paywall. A residential IP helps both." }), null, "A/B and an article are no sides");
  });

  it("every stored contradicts verdict below version 4 is asked again once, whatever tier finds the pair, or none, ranked with the contradicts tier", async () => {
    const root = await dir();
    const path = join(root, "pair-checks.json");
    const hashOf = (id: string) => `h-${id}`;
    const record = (a: string, b: string, verdict: string, inputVersion: number) => ({ a, b, hashA: hashOf(a), hashB: hashOf(b), verdict, note: "A says x. B says y.", checkedAt: "t", inputVersion });
    await writeFile(path, JSON.stringify({ version: 1, checks: [record("ke_a", "ke_b", "contradicts", 3), record("ke_a", "ke_c", "contradicts", 4), record("ke_b", "ke_c", "consistent", 3)] }));
    const checks = new KnowledgePairChecks({ path, hashOf, now: () => NOW });
    await checks.load();
    assert.deepEqual(checks.recheckPairs().map((p) => [p.a, p.b]), [["ke_a", "ke_b"]]);
    // Far apart, no concept in common: no tier finds the pair.
    const index = new FakeVectorIndex();
    index.set("ke_a", axis(8, 0));
    index.set("ke_b", axis(8, 3));
    index.set("ke_c", axis(8, 6));
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: () => [], contradicting: () => [] };
    const ids = ["ke_a", "ke_b", "ke_c"];
    const isChecked = (pair: { a: string; b: string; hashA: string; hashB: string }, reason: Parameters<typeof pairCheckNeedsRecheck>[2]) => checks.isChecked(pair, () => false, reason);
    assert.deepEqual(await pairCheckCandidates({ ids, view, hashOf, isChecked, limit: 30 }), [], "without the re-asks: nothing");
    const round = await pairCheckCandidates({ ids, view, hashOf, isChecked, limit: 30, recheck: checks.recheckPairs() });
    assert.deepEqual(round.map((c) => [c.a, c.b, c.reason]), [["ke_a", "ke_b", "contradicts"]]);
    await checks.record({ a: "ke_a", b: "ke_b", hashA: hashOf("ke_a"), hashB: hashOf("ke_b") }, "contradicts", "jason says x; Alex says y.");
    assert.deepEqual(checks.recheckPairs(), [], "asked once");
  });
});

describe("the numbers tier", () => {
  it("names that say one thing but for their numbers; number words count; a held subset, two unnumbered names or few shared words do not", () => {
    const differ = (x: string, y: string, unsaid = true) => numbersOnlyDiffer(claimNumbers(x), claimNumbers(y), unsaid);
    assert.deepEqual([...claimNumbers("One new device for each US number/TikTok account").numbers], ["1"]);
    assert.deepEqual([...claimNumbers("Warm up the TikTok account for 5-7 days").words].sort(), ["account", "tiktok", "up", "warm"]);
    assert.equal(differ("Warm up the TikTok account for 5-7 days", "TikTok account warm-up"), true, "advice may leave the number unsaid");
    assert.equal(differ("Warm up the TikTok account for 5-7 days", "TikTok account warm-up", false), false, "a result or metric without one is the same figure");
    assert.equal(differ("Warm up the TikTok account for 5-7 days", "Warm up each account for 3 days"), true);
    assert.equal(differ("Create TikTok accounts (2–3 maximum per device)", "One new device for each US number/TikTok account"), true);
    assert.equal(differ("3-5 days of warming up", "Warm up each account for 3 days"), false, "3 is within 3-5: one holds the other's numbers");
    assert.equal(differ("Get keywords from 1-2 star reviews of top 30 competitors", "Mine 1-2 star reviews of competitors"), false);
    assert.equal(differ("Warm up the account for 48 hours before posting", "2 posts per account per day"), false, "too few words in common");
    assert.equal(differ("TikTok account warm-up", "Warm up every TikTok account"), false, "no number on either side");
    assert.equal(differ("Warm up for 48 hours", "Warm up for 48 hours"), false);
  });

  it("claim concepts close by concept vector whose numbers differ, on entries by different authors: ranked after opposite advice, before shared claims; a version-3 consistent verdict is asked again for them", async () => {
    const index = new FakeVectorIndex(); // good = 0.5
    index.set("ke_alex", axis(16, 0));
    // Below `good` by entry vector: no other tier finds them (whatever the entries' closeness).
    index.set("ke_ema", around(16, 0, 1, 0.3));
    index.set("ke_ema2", around(16, 0, 2, 0.3)); // Ema again: the same author
    index.set("ke_jason", around(16, 0, 3, 0.95)); // shares a claim with Alex: the shared tier
    index.set("ke_far", axis(16, 9)); // its warm-up concept is far from the others by concept vector
    const concepts: Record<string, KnowledgeConceptRef[]> = {
      ke_alex: [
        { id: "t-warm", type: "Tactic", name: "TikTok account warm-up" },
        { id: "t-shared", type: "Tactic", name: "Factory reset the iPhone" }
      ],
      ke_ema: [{ id: "t-warm57", type: "Tactic", name: "Warm up the TikTok account for 5-7 days" }],
      ke_ema2: [{ id: "t-warm3", type: "Tactic", name: "Warm up each TikTok account for 3 days" }],
      ke_jason: [{ id: "t-shared", type: "Tactic", name: "Factory reset the iPhone" }],
      ke_far: [{ id: "t-warm48", type: "Tactic", name: "Warm up the TikTok account for 48 hours" }]
    };
    const conceptVectors: Record<string, Float32Array> = {
      "t-warm": Float32Array.from(axis(8, 0)),
      "t-warm57": Float32Array.from(around(8, 0, 1, 0.95)),
      "t-warm3": Float32Array.from(around(8, 0, 2, 0.93)),
      "t-warm48": Float32Array.from(axis(8, 5)),
      "t-shared": Float32Array.from(axis(8, 7))
    };
    const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: (id) => concepts[id] ?? [], contradicting: () => [], conceptVector: (id) => conceptVectors[id] ?? null };
    const authors: Record<string, string> = { ke_alex: "Alex", ke_ema: "Ema", ke_ema2: "Ema", ke_jason: "jason", ke_far: "Far" };
    const entryOf = (id: string): PairCheckEntryInfo => ({ kind: "post", author: authors[id]!, handle: null });
    const ids = [...index.embeddedIds()];
    const all = await pairCheckCandidates({ ids, view, hashOf: (id) => `h-${id}`, isChecked: () => false, limit: 30, entryOf });
    assert.deepEqual(
      all.map((c) => [c.a, c.b, c.reason]),
      [
        ["ke_alex", "ke_ema", "numbers"],
        ["ke_alex", "ke_ema2", "numbers"],
        ["ke_alex", "ke_jason", "shared"]
      ],
      "not Ema with Ema (one author), not the 48 hours (far by concept vector)"
    );
    assert.deepEqual(all[0]!.focus.map((c) => c.id).sort(), ["t-warm", "t-warm57"], "the two numbers' passages first");
    // A version-3 consistent check of a pair found for its numbers is asked again; any other stands.
    const v3 = { a: "ke_alex", b: "ke_ema", verdict: "consistent" as const, inputVersion: 3 };
    assert.equal(pairCheckNeedsRecheck(v3, () => false, "numbers"), true);
    assert.equal(pairCheckNeedsRecheck(v3, () => false, "shared"), false);
    assert.equal(pairCheckNeedsRecheck({ ...v3, inputVersion: 4 }, () => false, "numbers"), false, "asked once");
    const checked = await pairCheckCandidates({
      ids,
      view,
      hashOf: (id) => `h-${id}`,
      isChecked: (pair, reason) => (pair.b === "ke_ema" ? !pairCheckNeedsRecheck(v3, () => false, reason) : true),
      limit: 30,
      entryOf
    });
    assert.deepEqual(checked.map((c) => [c.a, c.b, c.reason]), [["ke_alex", "ke_ema", "numbers"]]);
    const { conceptVector: _none, ...withoutVectors } = view;
    const plain = await pairCheckCandidates({ ids, view: withoutVectors, hashOf: (id) => `h-${id}`, isChecked: () => false, limit: 30, entryOf });
    assert.deepEqual(plain.map((c) => c.reason), ["shared"], "without concept vectors: no numbers tier");
  });
});
