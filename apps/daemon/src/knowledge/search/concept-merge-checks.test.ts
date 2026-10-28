import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeConceptMergeCheck, KnowledgeConceptMergeRecord } from "@orquester/config";
import type { KnowledgeEmbedder } from "./embedder.ts";
import {
  CONCEPT_CHECK_EXCERPT_ENTRIES,
  CONCEPT_CHECK_INPUT_VERSION,
  CONCEPT_CHECK_STEP,
  CONCEPT_CHECK_SYSTEM,
  ConceptMergeCheckSource,
  E5_SMALL_CONCEPT_CHECK_BARS,
  conceptAnchors,
  conceptCheckCandidates,
  conceptCheckInput,
  conceptExcerpt,
  conceptExcerptFor,
  parseConceptCheckAnswer,
  validateConceptCheckAnswer,
  type ConceptCheckBars
} from "./concept-merge-checks.ts";
import { KnowledgeConceptMerges, personHandle, personHandlePairs, personRuleGroups, planConceptMerges, type ConceptMergeThresholds, type PlanConcept } from "./concept-merges.ts";
import { KnowledgeGraph, type GraphConcept } from "./graph.ts";
import { FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope } from "./visibility.ts";

const BARS: ConceptMergeThresholds = { merge: 0.91, similar: 0.93 };
const CHECK_BARS: ConceptCheckBars = { sharedEntry: 0.96, alone: 0.975 };
const noPause = async (): Promise<void> => undefined;
const DIMS = 24;

/** A unit vector at `cos` to axis `base`, leaning towards axis `side`. */
function vec(base: number, cos = 1, side = base + 1): Float32Array {
  const v = new Float32Array(DIMS);
  v[base] = cos;
  if (cos < 1) v[side] = Math.sqrt(1 - cos * cos);
  return v;
}

function concept(id: string, name: string, entryIds: string[], type = "Tactic", extra: Partial<GraphConcept> = {}): GraphConcept {
  return { id, type, name, confidence: 0.9, description: null, aliases: [], attributes: {}, entryIds, ...extra };
}

// ---------------------------------------------------------------------------
// The Person rule
// ---------------------------------------------------------------------------

test("the Person rule: the same handle, or a handle written out as another Person's name, is the same person; nothing else is", async () => {
  assert.equal(personHandle("@JasonUGC"), "jasonugc");
  assert.equal(personHandle(" @danielhangan_ "), "danielhangan_", "punctuation is part of a handle");
  assert.equal(personHandle("Al"), null, "too short to say");
  assert.equal(personHandle("x.com/alex"), null, "not a handle");
  const p = (id: string, name: string, handle: string | null, type = "Person"): PlanConcept => ({ id, type, name, entryCount: 1, handle });
  const concepts = [
    p("person-jason", "jason", "jasonugc"),
    p("person-jasonugc", "jasonugc", null),
    p("person-personjasonugc", "person-personjasonugc", "@jasonugc"), // no name: the graph names it by its id
    p("person-kcodes", "KCodes7777", null),
    p("person-penelope", "Penelope Lopez", "KCodes7777"),
    p("person-other", "Someone", "danielhangan"),
    p("person-daniel", "daniel", "danielhangan_"), // another account
    p("tool-jasonugc", "jasonugc", "jasonugc", "Tool") // not a Person
  ];
  assert.deepEqual(personHandlePairs(concepts), [
    ["person-jason", "person-jasonugc"],
    ["person-jason", "person-personjasonugc"],
    ["person-jasonugc", "person-personjasonugc"],
    ["person-kcodes", "person-penelope"]
  ]);
  // Far apart by vector and refused by the name guard: merged anyway, never across an undo.
  const vectors = new Map(concepts.map((c, i) => [c.id, vec(i)]));
  const { merges } = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing: [], rejected: [], now: "t", pause: noPause });
  assert.deepEqual(
    merges.map((m) => [m.into, [...m.merged].sort(), m.source]).sort(),
    [
      ["person-jason", ["person-jasonugc", "person-personjasonugc"], undefined],
      ["person-kcodes", ["person-penelope"], undefined]
    ]
  );
  const undone = await planConceptMerges({
    concepts,
    vectors,
    thresholds: BARS,
    existing: [],
    rejected: [{ id: "cm_x", type: "Person", concepts: ["person-kcodes", "person-penelope"], rejectedAt: "t" }],
    now: "t",
    pause: noPause
  });
  assert.equal(undone.merges.some((m) => m.into === "person-kcodes" || m.into === "person-penelope"), false);
});

test("the Person rule never merges different people: a first name is no handle, different full names never pair, pairs never chain", async () => {
  const p = (id: string, name: string, handle: string | null): PlanConcept => ({ id, type: "Person", name, entryCount: 1, handle });
  const plan = async (concepts: PlanConcept[], existing: KnowledgeConceptMergeRecord[] = []) =>
    (
      await planConceptMerges({ concepts, vectors: new Map(concepts.map((c, i) => [c.id, vec(i)])), thresholds: BARS, existing, rejected: [], now: "t", pause: noPause })
    ).merges.map((m) => [m.into, [...m.merged].sort()]);
  // The same handle on two platforms, and a first name equal to it.
  const alexes = [p("person-alex", "Alex", null), p("person-alex-nguyen", "Alex Nguyen", "@alex"), p("person-alex-chen", "Alex Chen", "alex")];
  assert.deepEqual(personHandlePairs(alexes), []);
  assert.deepEqual(await plan(alexes), []);
  // A first name is not the handle of a longer name.
  assert.deepEqual(await plan([p("person-sam", "Sam", null), p("person-samantha", "Samantha Lee", "sam")]), []);
  // The account "alexdev" (its name, and two unnamed Persons of that handle) is one; it pairs with two
  // different people too, so it joins neither of them.
  const chained = [
    p("person-nguyen", "Alex Nguyen", "alexdev"),
    p("person-chen", "Alex Chen", "alexdev"),
    p("person-alexdev", "alexdev", null),
    p("person-p1", "person-p1", "alexdev"),
    p("person-p2", "person-p2", "alexdev")
  ];
  assert.deepEqual(personRuleGroups(chained), [["person-alexdev", "person-p1", "person-p2"]]);
  assert.deepEqual(await plan(chained), [["person-alexdev", ["person-p1", "person-p2"]]]);
  // A Person merge an earlier rule made between different people is dropped; one of the same person stays.
  const earlier: KnowledgeConceptMergeRecord[] = [
    { id: "cm_bad", type: "Person", into: "person-alex-nguyen", merged: ["person-alex", "person-alex-chen"], similarity: 1, createdAt: "t" },
    { id: "cm_ok", type: "Person", into: "person-jason", merged: ["person-jasonugc"], similarity: 1, createdAt: "t" }
  ];
  assert.deepEqual(await plan([...alexes, p("person-jason", "jason", "jasonugc"), p("person-jasonugc", "jasonugc", null)], earlier), [["person-jason", ["person-jasonugc"]]]);
});

// ---------------------------------------------------------------------------
// Merges from checks
// ---------------------------------------------------------------------------

test("a checked pair merges whatever the guards say, as `source: checked`, keeping the checker's choice; an absorbed checked merge stays checked", async () => {
  const c = (id: string, name: string, entryCount = 1): PlanConcept => ({ id, type: "Tactic", name, entryCount });
  const concepts = [c("tactic-48h", "48-hour account warm-up", 3), c("tactic-warm", "Warm up the account for 48 hours before posting"), c("tactic-x", "Something else")];
  const vectors = new Map([
    ["tactic-48h", vec(0)],
    ["tactic-warm", vec(0, 0.985)],
    ["tactic-x", vec(5)]
  ]);
  const plain = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing: [], rejected: [], now: "t", pause: noPause });
  assert.deepEqual(plain.merges, [], "the guard refuses it");
  const checked = await planConceptMerges({
    concepts,
    vectors,
    thresholds: BARS,
    existing: [],
    rejected: [],
    checked: [{ a: "tactic-48h", b: "tactic-warm", similarity: 0.985, keep: "tactic-warm" }],
    now: "t",
    pause: noPause
  });
  assert.deepEqual(
    checked.merges.map((m) => [m.into, m.merged, m.similarity, m.source]),
    [["tactic-warm", ["tactic-48h"], 0.985, "checked"]],
    "the checker kept the clearer name though the other has more entries"
  );
  // Re-planned: the same record stays (nothing changes).
  const again = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing: checked.merges, rejected: [], checked: [{ a: "tactic-48h", b: "tactic-warm", similarity: 0.985, keep: "tactic-warm" }], now: "t2", pause: noPause });
  assert.equal(again.changed, false);
  // Undone: never again, though the check said the same.
  const undone = await planConceptMerges({
    concepts,
    vectors,
    thresholds: BARS,
    existing: [],
    rejected: [{ id: checked.merges[0]!.id, type: "Tactic", concepts: ["tactic-warm", "tactic-48h"], rejectedAt: "t" }],
    checked: [{ a: "tactic-48h", b: "tactic-warm", similarity: 0.985, keep: "tactic-warm" }],
    now: "t",
    pause: noPause
  });
  assert.deepEqual(undone.merges, []);
  // A checked merge a rule's pair grows: the new group is still checked.
  const grown = await planConceptMerges({
    concepts: [...concepts, c("tactic-48h-2", "48 hour account warm-up")],
    vectors: new Map([...vectors, ["tactic-48h-2", vec(0, 0.99)]]),
    thresholds: BARS,
    existing: checked.merges,
    rejected: [],
    now: "t3",
    pause: noPause
  });
  assert.deepEqual(
    grown.merges.map((m) => [[m.into, ...m.merged].sort(), m.source]),
    // (the rule's pair joins the checked group)
    [[["tactic-48h", "tactic-48h-2", "tactic-warm"], "checked"]]
  );
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test("candidates: a name guard refused them, close enough (higher bar without a shared entry), a word in common; shared entries first; merged, undone and checked pairs left out", async () => {
  const concepts = [
    concept("tactic-48h", "48-hour account warm-up", ["ke_1"]),
    concept("tactic-warm", "Warm up the account for 48 hours before posting", ["ke_1"]),
    concept("tactic-risk", "Proxy risk check", ["ke_1"]),
    concept("tactic-score", "Check proxy fraud score on IPQualityScore and Scamalytics", ["ke_2"]),
    concept("tactic-score-far", "Check proxy fraud score", ["ke_3"]), // 0.97 to risk, no shared entry: below the bar
    concept("tactic-72", "72-hour trial", ["ke_4"]),
    concept("tactic-7d", "7-day trial", ["ke_4"]), // numbers on both sides: never
    concept("tactic-no", "Do not offer a free trial", ["ke_5"]),
    concept("tactic-yes", "Offer a free trial", ["ke_5"]), // one negates: never
    concept("aiservice-copilot", "Copilot", ["ke_6"], "AIService"),
    concept("aiservice-sd", "Stable Diffusion", ["ke_6"], "AIService"), // no word in common
    concept("person-a", "jason", ["ke_7"], "Person"),
    concept("person-b", "jason ugc", ["ke_7"], "Person"), // Persons: never asked
    concept("tactic-m1", "Warm up TikTok account daily", ["ke_8"]),
    concept("tactic-m2", "Warm up the TikTok account every day", ["ke_8"]), // merged already
    concept("tactic-r1", "Post daily on TikTok", ["ke_9"]),
    concept("tactic-r2", "Post on TikTok every single day", ["ke_9"]), // undone
    concept("tactic-c1", "Use a landing page", ["ke_10"]),
    concept("tactic-c2", "Landing page for every ad", ["ke_10"]) // checked at these names
  ];
  const vectors = new Map<string, Float32Array>([
    ["tactic-48h", vec(0)],
    ["tactic-warm", vec(0, 0.985)],
    ["tactic-risk", vec(2)],
    ["tactic-score", vec(2, 0.98)],
    ["tactic-score-far", vec(2, 0.97, 4)],
    ["tactic-72", vec(5)],
    ["tactic-7d", vec(5, 0.99)],
    ["tactic-no", vec(7)],
    ["tactic-yes", vec(7, 0.99)],
    ["aiservice-copilot", vec(9)],
    ["aiservice-sd", vec(9, 0.99)],
    ["person-a", vec(11)],
    ["person-b", vec(11, 0.99)],
    ["tactic-m1", vec(13)],
    ["tactic-m2", vec(13, 0.99)],
    ["tactic-r1", vec(15)],
    ["tactic-r2", vec(15, 0.99)],
    ["tactic-c1", vec(17)],
    ["tactic-c2", vec(17, 0.99)]
  ]);
  const check: KnowledgeConceptMergeCheck = { a: "tactic-c1", b: "tactic-c2", type: "Tactic", nameA: "Use a landing page", nameB: "Landing page for every ad", same: false, keep: null, reason: "r", similarity: 0.99, checkedAt: "t" };
  const input = {
    concepts,
    vectors,
    thresholds: BARS,
    bars: CHECK_BARS,
    rejected: [{ id: "cm_r", type: "Tactic", concepts: ["tactic-r1", "tactic-r2"], rejectedAt: "t" }],
    checks: [check],
    canonical: (id: string) => (id === "tactic-m2" ? "tactic-m1" : id),
    limit: 40,
    pause: noPause
  };
  const found = await conceptCheckCandidates(input);
  assert.deepEqual(
    found.map((c) => [c.a.id, c.b.id, c.sharesEntry, c.refusal]),
    [
      ["tactic-48h", "tactic-warm", true, "lexical"],
      ["tactic-risk", "tactic-score", false, "lexical"]
    ]
  );
  assert.equal((await conceptCheckCandidates({ ...input, limit: 1 })).length, 1, "the cap");
  // A concept renamed since its check: asked again.
  const renamed = await conceptCheckCandidates({ ...input, concepts: concepts.map((c) => (c.id === "tactic-c2" ? { ...c, name: "Landing page per ad" } : c)) });
  assert.ok(renamed.some((c) => c.a.id === "tactic-c1" && c.b.id === "tactic-c2"));
});

test("candidates: names that nearly coincide are asked about at the lower `alikeNames` bar, with or without a shared entry; an item and the list naming it, or one word in common, are not", async () => {
  // Live pairs (2026-10-27) below the bar for concepts sharing no entry.
  const concepts = [
    concept("tactic-and", "US App Store download and warm-up", ["ke_1"]),
    concept("tactic-plus", "US App Store download plus warm-up", ["ke_2"]), // 6 of 7 words: asked
    concept("tactic-isp-check", "ISP proxy with IPQS/Scamalytics risk check", ["ke_3"]),
    concept("tactic-isp-pass", "ISP proxy that passes IPQS and Scamalytics", ["ke_3"]), // 4 of 8 words, same entry: asked
    concept("tactic-low-risk", "Check the proxy for low risk", ["ke_5"]), // 3 of 7 words with the risk check (0.97): not
    concept("tactic-tumblr", "Tumblr posts as backlinks", ["ke_6"]),
    concept("tactic-list", "Facebook groups, YouTube community posts, AI pages and Tumblr backlinks", ["ke_7"]), // 3 of 11 words: not
    concept("tactic-proxy-check", "Proxy risk check", ["ke_8"]),
    concept("tactic-proxy-analysis", "Proxy risk analysis", ["ke_9"]) // half their words shared, but only two: not
  ];
  const vectors = new Map<string, Float32Array>([
    ["tactic-and", vec(0)],
    ["tactic-plus", vec(0, 0.964)],
    ["tactic-isp-check", vec(2)],
    ["tactic-isp-pass", vec(2, 0.947)],
    ["tactic-low-risk", vec(2, 0.97, 4)],
    ["tactic-tumblr", vec(5)],
    ["tactic-list", vec(5, 0.95)],
    ["tactic-proxy-check", vec(7)],
    ["tactic-proxy-analysis", vec(7, 0.95)]
  ]);
  const input = { concepts, vectors, thresholds: BARS, rejected: [], checks: [], canonical: (id: string) => id, limit: 40, pause: noPause };
  const found = await conceptCheckCandidates({ ...input, bars: { ...CHECK_BARS, alikeNames: 0.94 } });
  assert.deepEqual(
    found.map((c) => [c.a.id, c.b.id]),
    [
      ["tactic-isp-check", "tactic-isp-pass"],
      ["tactic-and", "tactic-plus"]
    ]
  );
  assert.deepEqual(await conceptCheckCandidates({ ...input, bars: CHECK_BARS }), [], "without the bar: below the one for concepts sharing no entry");
  assert.equal(E5_SMALL_CONCEPT_CHECK_BARS.alikeNames, 0.94);
});

test("anchors: distinctive Tool / Organization / Product concepts a concept links to or names (an alias too); a common one anchors nothing", () => {
  // 40 entries: an anchor is distinctive at ≤ 3 of them (8%).
  const filler = Array.from({ length: 40 }, (_, i) => `ke_f${i}`);
  const concepts = [
    concept("tool-ipqs", "IPQualityScore", ["ke_1", "ke_2"], "Tool", { aliases: ["IPQS"] }),
    concept("tool-scam", "Scamalytics", ["ke_1", "ke_2"], "Tool"),
    concept("tool-gmail", "Gmail", ["ke_3", "ke_4"], "Tool"),
    concept("organization-apple", "Apple", filler, "Organization"), // in every entry: not distinctive
    concept("tactic-a", "Buy a clean ISP proxy with an IPQS/Scamalytics check", ["ke_1"]),
    concept("tactic-b", "Proxy fraud check", ["ke_2"]), // linked, not named
    concept("tactic-c", "Use Gmail only", ["ke_3"]),
    concept("tactic-d", "Sign in with Apple", ["ke_5"])
  ];
  const edges = [
    { from: "tactic-b", to: "tool-scam" },
    { from: "tactic-d", to: "organization-apple" },
    { from: "tool-gmail", to: "tool-scam" } // anchors link anchors: each is the other's
  ];
  const anchors = conceptAnchors(concepts, edges, (id) => id);
  const of = (id: string) => [...(anchors.get(id) ?? [])].sort();
  assert.deepEqual(of("tactic-a"), ["tool-ipqs", "tool-scam"], "named, an alias included");
  assert.deepEqual(of("tactic-b"), ["tool-scam"], "linked");
  assert.deepEqual(of("tactic-c"), ["tool-gmail"]);
  assert.deepEqual(of("tactic-d"), [], "Apple is in too many entries");
  assert.deepEqual(of("tool-gmail"), ["tool-scam"]);
  assert.deepEqual(of("tool-ipqs"), [], "never its own anchor");
  // Merged anchors count as one.
  const merged = conceptAnchors(concepts, edges, (id) => (id === "tool-scam" ? "tool-ipqs" : id));
  assert.deepEqual([...(merged.get("tactic-a") ?? [])], ["tool-ipqs"]);
});

test("candidates: tactics of different entries that share an anchor are asked about at the `anchored` bar (the live IPQS and Gmail groups); a shared entry, one-sided numbers or the anchors themselves are not", async () => {
  const concepts = [
    concept("tool-ipqs", "IPQualityScore", ["ke_1", "ke_2", "ke_3"], "Tool", { aliases: ["IPQS"] }),
    concept("tool-scam", "Scamalytics", ["ke_1", "ke_2", "ke_9"], "Tool"),
    concept("tool-gmail", "Gmail", ["ke_4", "ke_5", "ke_6"], "Tool"),
    concept("tool-outlook", "Outlook", ["ke_4", "ke_5"], "Tool"),
    // The live IPQS group (names from the live graph of 2026-10-28, cosines about as close).
    concept("tactic-buy-clean", "Buy a clean ISP proxy with an IPQS/Scamalytics check", ["ke_1"]),
    concept("tactic-passes", "ISP proxy that passes IPQS and Scamalytics", ["ke_2"]),
    concept("tactic-check-ip", "Check IP quality on IPQS/Scamalytics before creating the account", ["ke_3"]),
    concept("tactic-us-vpn", "US VPN with IP check on Scamalytics (<60)", ["ke_9"]), // numbers on one side: not on this path
    // The live Gmail group.
    concept("tactic-only-safe", "Only Gmail is safe", ["ke_4"]),
    concept("tactic-use-only", "Use Gmail only", ["ke_5"]),
    concept("tactic-gmail-tiktok", "Gmail only for TikTok account", ["ke_6"]),
    concept("tactic-strip", "Strip dots for Gmail addresses", ["ke_4", "ke_5", "ke_6"]) // shares an entry with each: the name paths' business
  ];
  const vectors = new Map<string, Float32Array>([
    ["tool-ipqs", vec(20)],
    ["tool-scam", vec(20, 0.95)], // anchor types: never paired on this path
    ["tool-gmail", vec(22)],
    ["tool-outlook", vec(22, 0.97)],
    ["tactic-buy-clean", vec(0)],
    ["tactic-passes", vec(0, 0.946)],
    ["tactic-check-ip", vec(0, 0.96, 2)],
    ["tactic-us-vpn", vec(0, 0.93, 3)],
    ["tactic-only-safe", vec(5)],
    ["tactic-use-only", vec(5, 0.957)],
    ["tactic-gmail-tiktok", vec(5, 0.955, 7)],
    ["tactic-strip", vec(5, 0.95, 8)]
  ]);
  const edges = [{ from: "tactic-passes", to: "tool-ipqs" }];
  const input = { concepts, vectors, edges, thresholds: BARS, rejected: [], checks: [], canonical: (id: string) => id, limit: 40, pause: noPause };
  assert.deepEqual(await conceptCheckCandidates({ ...input, bars: CHECK_BARS }), [], "without the bar: none of them is close enough for the name paths");
  const found = await conceptCheckCandidates({ ...input, bars: { ...CHECK_BARS, anchored: 0.9 } });
  const pairs = found.map((c) => [c.a.id, c.b.id, c.refusal, c.anchors]);
  assert.deepEqual(
    pairs.filter(([a]) => String(a).includes("ipqs") || ["tactic-buy-clean", "tactic-check-ip", "tactic-passes"].includes(String(a))),
    [
      ["tactic-buy-clean", "tactic-check-ip", "lexical", ["tool-ipqs", "tool-scam"]],
      ["tactic-buy-clean", "tactic-passes", "lexical", ["tool-ipqs", "tool-scam"]],
      ["tactic-check-ip", "tactic-passes", "lexical", ["tool-ipqs", "tool-scam"]]
    ]
  );
  assert.deepEqual(
    found.filter((c) => c.anchors?.includes("tool-gmail")).map((c) => [c.a.id, c.b.id]),
    [
      ["tactic-only-safe", "tactic-use-only"],
      ["tactic-gmail-tiktok", "tactic-only-safe"],
      ["tactic-gmail-tiktok", "tactic-use-only"]
    ]
  );
  assert.ok(!found.some((c) => c.a.id === "tactic-us-vpn" || c.b.id === "tactic-us-vpn"), "one name has numbers");
  assert.ok(!found.some((c) => c.a.id === "tactic-strip" || c.b.id === "tactic-strip"), "a shared entry, below its bar");
  assert.ok(!found.some((c) => c.a.type === "Tool"), "the anchor types themselves");
  // Below the merge bar and past every name guard: still asked (the rule would not merge them).
  const plain = await conceptCheckCandidates({
    ...input,
    concepts: [concepts[2]!, concept("tactic-g1", "Gmail account", ["ke_4"]), concept("tactic-g2", "Gmail accounts", ["ke_5"])],
    vectors: new Map([...vectors, ["tactic-g1", vec(10)], ["tactic-g2", vec(10, 0.905)]]),
    bars: { ...CHECK_BARS, anchored: 0.9 }
  });
  assert.deepEqual(plain.map((c) => [c.a.id, c.b.id, c.refusal]), [["tactic-g1", "tactic-g2", "similarity"]]);
  assert.equal(E5_SMALL_CONCEPT_CHECK_BARS.anchored, 0.9);
});

// ---------------------------------------------------------------------------
// The task and its answers
// ---------------------------------------------------------------------------

test("the task shows both concepts with type, aliases, description and an excerpt; the instructions say what is not the same", () => {
  const input = conceptCheckInput(
    { type: "Tactic", name: "48-hour account warm-up", aliases: ["48h warm-up"], description: "Warm up for 48 hours", excerpt: { title: "Make any phone hit a US audience", text: "warm up the account for 48 hours before posting." } },
    { type: "Tactic", name: "Warm up the account for 48 hours before posting", aliases: [], description: null, excerpt: null }
  );
  assert.match(input, /CONCEPT A\n=+\nType: Tactic\nName: 48-hour account warm-up\nAliases: 48h warm-up\nDescription: Warm up for 48 hours\nExcerpt from "Make any phone hit a US audience": warm up/);
  assert.match(input, /CONCEPT B\n=+\nType: Tactic\nName: Warm up the account for 48 hours before posting\n\nAre A and B the same thing\?/);
  assert.match(CONCEPT_CHECK_SYSTEM, /same level of specificity/);
  assert.match(CONCEPT_CHECK_SYSTEM, /different numbers/);
  assert.match(CONCEPT_CHECK_SYSTEM, /negation/);
  assert.match(CONCEPT_CHECK_SYSTEM, /scope/);
  // The same action with the same tools is the same, however phrased; numbers, conditions and tools keep them apart.
  assert.match(CONCEPT_CHECK_SYSTEM, /same action with the same tools[^\n]*ARE the same, however each is phrased/);
  assert.match(CONCEPT_CHECK_SYSTEM, /"Buy a clean ISP proxy with an IPQS\/Scamalytics check" and "Check the proxy on IPQS and Scamalytics" are the same/);
  assert.match(CONCEPT_CHECK_SYSTEM, /different conditions/);
  assert.match(CONCEPT_CHECK_SYSTEM, /different or additional tools/);
  assert.match(CONCEPT_CHECK_SYSTEM, /\{"same": true \| false, "keep": "a" \| "b", "reason"/);

  const body = "Intro line about phones.\n\n7) Proxy risk check: run it on ipqualityscore and scamalytics, both must read low risk. Then continue.\n\n8) Warm up.";
  assert.deepEqual(conceptExcerpt(body, { name: "Proxy risk check", aliases: [] }), {
    text: "7) Proxy risk check: run it on ipqualityscore and scamalytics, both must read low risk. Then continue. 8) Warm up.",
    score: 2
  });
  const none = conceptExcerpt("x ".repeat(400), { name: "nothing", aliases: [] });
  assert.ok(none.text.startsWith("x x") && none.text.endsWith("[…]"), "nothing names it: the opening");
  assert.equal(none.score, 0);
});

test("concept excerpts: the passage naming the concept (name or alias whole, else the largest share of one's words), not the opening", () => {
  const body = [
    "Intro about games and apps in general, nothing specific here.",
    "Guidelines for casual, hardcore, streaming, and gambling apps.",
    "Section 4.7: Mini games, streaming games and emulators must follow every rule.",
    "Later: streaming games again."
  ].join("\n");
  // The name whole beats a sentence with its words apart; the first such sentence wins.
  assert.ok(conceptExcerpt(body, { name: "Streaming games", aliases: [] }).text.startsWith("Section 4.7: Mini games, streaming games"));
  // An alias whole counts like the name.
  const aliased = conceptExcerpt("Opening.\nThe app directory moved.\nNow called the Plugin Directory since July.", { name: "ChatGPT Plugin Directory", aliases: ["Plugin Directory"] });
  assert.deepEqual([aliased.text.startsWith("Now called the Plugin Directory"), aliased.score], [true, 2]);
  // No phrase: the share of one name's words (an alias's words do not add to the name's).
  const shared = conceptExcerpt("Opening.\nWarm the phone.\nWarm up the account for two days before posting.", { name: "Account warm-up before posting", aliases: [] });
  assert.ok(shared.text.startsWith("Warm up the account for two days"), shared.text);
  assert.ok(shared.score > 0 && shared.score < 2);
  // Punctuation and case do not hide a name ("GPT-4" in "(ChatGPT, GPT-4, Gemini)").
  assert.equal(conceptExcerpt("Use no brand names.\nDon't keyword-stuff with AI brand names (ChatGPT, GPT-4, Gemini, etc.).", { name: "GPT-4", aliases: [] }).score, 2);
});

test("concept excerpts across entries: the first entries are searched, the best naming one is shown, a tie keeps the earlier", async () => {
  const bodies: Record<string, { title: string; body: string }> = {
    ke_1: { title: "First", body: "About warm-ups in general.\nSome other text." },
    ke_2: { title: "Second", body: "Opening.\nWarm up the account for 48 hours before posting, every time." },
    ke_3: { title: "Third", body: "Warm up the account for 48 hours before posting." },
    ke_4: { title: "Fourth", body: "Nothing." }
  };
  const read: string[] = [];
  const entry = async (id: string) => {
    read.push(id);
    return bodies[id] ?? null;
  };
  const found = await conceptExcerptFor({ name: "Warm up the account for 48 hours before posting", aliases: [], entryIds: ["ke_1", "ke_2", "ke_3", "ke_4"] }, entry);
  assert.deepEqual(found, { title: "Second", text: "Warm up the account for 48 hours before posting, every time.", score: 2 });
  assert.deepEqual(read, ["ke_1", "ke_2"], "a whole name ends the search");
  read.length = 0;
  const weak = await conceptExcerptFor({ name: "Account warm-up", aliases: [], entryIds: ["ke_4", "ke_1", "ke_9", "ke_4"] }, entry);
  assert.equal(weak?.title, "First", "the first entry with the best share");
  assert.equal(read.length, CONCEPT_CHECK_EXCERPT_ENTRIES, "at most the first few entries");
  assert.equal(await conceptExcerptFor({ name: "x", aliases: [], entryIds: ["ke_9"] }, entry), null);
});

test("answers: exactly {same, keep, reason}; anything else (bad JSON too) is refused", () => {
  assert.equal(validateConceptCheckAnswer({ same: true, keep: "a", reason: "Same warm-up." }), null);
  for (const bad of [
    null,
    [],
    "yes",
    { same: "true", keep: "a", reason: "x" },
    { same: true, keep: "c", reason: "x" },
    { same: true, keep: "a" },
    { same: true, keep: "a", reason: " " },
    { same: true, keep: "a", reason: "x".repeat(301) },
    { same: true, keep: "a", reason: "x", confidence: 1 }
  ]) {
    assert.equal(typeof validateConceptCheckAnswer(bad), "string", JSON.stringify(bad));
  }
  assert.deepEqual(parseConceptCheckAnswer('{"same": false, "keep": "b", "reason": " Different durations. "}'), { same: false, keep: "b", reason: "Different durations." });
  assert.equal(parseConceptCheckAnswer("{same: true}"), null);
  assert.equal(parseConceptCheckAnswer('{"same": true}'), null);
});

// ---------------------------------------------------------------------------
// The source over KnowledgeConceptMerges
// ---------------------------------------------------------------------------

const E1 = "ke_aaaaaaaaaaaa";
const E2 = "ke_bbbbbbbbbbbb";
const COLL = "kc_aaaaaaaaaa";

/** Concept vectors by name: what the text starts with decides. */
function namedEmbedder(byName: Record<string, Float32Array>): KnowledgeEmbedder {
  return {
    modelId: "fake/concepts",
    dimensions: DIMS,
    thresholds: { minimum: 0.2, good: 0.4, strong: 0.6, duplicate: 0.95 },
    async embed(texts) {
      return texts.map((text) => {
        const name = Object.keys(byName).find((key) => text.includes(`: ${key}.`) || text.endsWith(`: ${key}`));
        return name ? byName[name]! : vec(DIMS - 1);
      });
    }
  };
}

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kg-concept-checks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "concept-merges.json");
  const store = new FakeStore();
  store.collection(COLL, "C");
  store.put(E1, "Make any phone hit a US audience. Warm up the account for 48 hours before posting, scroll a few times a day.", [COLL], { title: "US TikTok phone" }, true);
  store.put(E2, "Proxy risk check on ipqs.", [COLL], { title: "Proxies" }, true);
  const logger = silentLogger();
  const graph = new KnowledgeGraph({ entries: store, logger });
  const embedder = namedEmbedder({
    "48-hour account warm-up": vec(0),
    "Warm up the account for 48 hours before posting": vec(0, 0.985),
    "Proxy risk check": vec(2),
    "Check proxy fraud score": vec(2, 0.98),
    "Check the proxy fraud score": vec(2, 0.98),
    jason: vec(4),
    jasonugc: vec(6)
  });
  let clock = Date.parse("2026-10-27T12:00:00.000Z");
  const merges = new KnowledgeConceptMerges({
    graph,
    embedders: new FakeEmbedderSource(embedder),
    path,
    vectorsDir: join(dir, "index", "concepts"),
    logger,
    now: () => new Date((clock += 1000)),
    thresholds: () => BARS,
    pause: noPause
  });
  t.after(() => merges.stop());
  const source = new ConceptMergeCheckSource({
    merges,
    entry: async (id) => {
      const entry = store.getMeta(id);
      return entry ? { title: entry.title, body: (await store.getEntry(id))!.body } : null;
    },
    bars: () => CHECK_BARS,
    now: () => new Date("2026-10-27T13:00:00.000Z"),
    pause: noPause
  });
  const nodes = [
    node("tactic-48h", "48-hour account warm-up", [`${E1}.md`]),
    node("tactic-warm", "Warm up the account for 48 hours before posting", [`${E1}.md`]),
    node("tactic-risk", "Proxy risk check", [`${E2}.md`]),
    node("tactic-score", "Check proxy fraud score", [`${E1}.md`]),
    node("person-jason", "jason", [`${E1}.md`], { type: "Person", attributes: { handle: { value: "jasonugc", confidence: 0.9 } } }),
    node("person-jasonugc", "jasonugc", [`${E2}.md`], { type: "Person" })
  ];
  return {
    graph,
    merges,
    source,
    nodes,
    all: knowledgeScope({ kind: "all" }, [COLL]),
    file: async () => JSON.parse(await readFile(path, "utf8")) as { merges: KnowledgeConceptMergeRecord[]; checks: KnowledgeConceptMergeCheck[]; rejected: unknown[] }
  };
}

test("the source: tasks once planning is done, a 'same' answer merges (checked), a 'different' one is remembered, undo never asks again", async (t) => {
  const h = await harness(t);
  let planned = 0;
  h.source.onWork(() => (planned += 1));
  await h.merges.start();
  assert.deepEqual(await h.source.tasks(), [], "no vectors yet: nothing to ask");
  await loadGraph(h.graph, h.nodes);
  await h.merges.idle();
  assert.ok(planned >= 1, "planning announced work");
  // The Person rule merged jason and jasonugc on its own.
  assert.equal(h.graph.canonicalConceptId("person-jasonugc"), h.graph.canonicalConceptId("person-jason"));

  const tasks = await h.source.tasks();
  assert.deepEqual(
    tasks.map((task) => task.label),
    [`${CONCEPT_CHECK_STEP} tactic-48h tactic-warm`, `${CONCEPT_CHECK_STEP} tactic-risk tactic-score`]
  );
  assert.match(tasks[0]!.user, /Name: 48-hour account warm-up\nExcerpt from "US TikTok phone": Warm up the account for 48 hours before posting, scroll a few times a day\./);
  assert.equal(tasks[0]!.system, CONCEPT_CHECK_SYSTEM);
  assert.equal((tasks[0]!.payload as { inputVersion?: number }).inputVersion, CONCEPT_CHECK_INPUT_VERSION);
  // A pair rounds gave up on is skipped, and the next one takes its place under the cap.
  const one = new ConceptMergeCheckSource({ merges: h.merges, entry: async () => null, bars: () => CHECK_BARS, limit: 1, pause: noPause });
  assert.deepEqual((await one.tasks()).map((task) => task.label), [tasks[0]!.label]);
  assert.deepEqual((await one.tasks({ skip: (task) => task.label === tasks[0]!.label })).map((task) => task.label), [tasks[1]!.label]);

  assert.equal(h.source.validate({ same: true, keep: "b", reason: "Same." }), null);
  assert.equal(typeof h.source.validate({ same: "yes" }), "string");
  await h.source.record(tasks[0]!.payload, JSON.stringify({ same: true, keep: "b", reason: "Same 48-hour warm-up." }));
  await h.source.record(tasks[1]!.payload, JSON.stringify({ same: false, keep: "b", reason: "A check vs one way to do it." }));
  await h.merges.idle();
  const merge = h.merges.list(h.all).find((m) => m.into.id === "tactic-warm");
  assert.ok(merge, JSON.stringify(h.merges.list(h.all)));
  assert.equal(merge.source, "checked");
  assert.deepEqual(merge.merged.map((m) => m.id), ["tactic-48h"]);
  assert.equal(h.merges.count(), 2, "the checked merge and the Person rule's");
  const file = await h.file();
  assert.deepEqual(
    file.checks.map((c) => [c.a, c.b, c.same, c.keep, c.inputVersion]),
    [
      ["tactic-48h", "tactic-warm", true, "tactic-warm", CONCEPT_CHECK_INPUT_VERSION],
      ["tactic-risk", "tactic-score", false, "tactic-score", CONCEPT_CHECK_INPUT_VERSION]
    ]
  );
  assert.deepEqual(await h.source.tasks(), [], "both pairs answered: nothing asked again");

  // Undone like any merge: apart, and never asked or merged again.
  assert.equal(await h.merges.undo(merge.id, h.all), true);
  assert.notEqual(h.graph.canonicalConceptId("tactic-48h"), h.graph.canonicalConceptId("tactic-warm"));
  await loadGraph(h.graph, h.nodes);
  await h.merges.idle();
  assert.notEqual(h.graph.canonicalConceptId("tactic-48h"), h.graph.canonicalConceptId("tactic-warm"));
  assert.deepEqual(await h.source.tasks(), []);
  // A concept renamed (same id) is asked about again.
  await loadGraph(h.graph, h.nodes.map((n) => (n.id === "tactic-score" ? node("tactic-score", "Check the proxy fraud score", [`${E1}.md`]) : n)));
  await h.merges.idle();
  assert.deepEqual(
    (await h.source.tasks()).map((task) => task.label),
    [`${CONCEPT_CHECK_STEP} tactic-risk tactic-score`]
  );
});

test("record ignores an answer that does not validate or a payload it did not write", async (t) => {
  const h = await harness(t);
  await h.merges.start();
  await loadGraph(h.graph, h.nodes);
  await h.merges.idle();
  const [task] = await h.source.tasks();
  await h.source.record(task!.payload, "not json");
  await h.source.record({ nope: true }, JSON.stringify({ same: true, keep: "a", reason: "x" }));
  await h.merges.idle();
  assert.equal((await h.source.tasks()).length, 2, "nothing recorded");
});
