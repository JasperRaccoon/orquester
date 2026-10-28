import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KNOWLEDGE_CONCEPT_SUMMARIES_VERSION } from "@orquester/config";
import { GMAIL_PASSAGE, LONG_GUIDE } from "../linking/fixtures/tiktok-guides.ts";
import type { KnowledgeRoundTask } from "../ports.ts";
import {
  CONCEPT_SUMMARY_CLAIM_MAX,
  CONCEPT_SUMMARY_MAX_ENTRIES,
  CONCEPT_SUMMARY_STEP,
  CONCEPT_SUMMARY_SYSTEM,
  CONCEPT_SUMMARY_TEXT_MAX,
  KnowledgeConceptSummaries,
  conceptSummaryInput,
  parseConceptSummaryAnswer,
  validateConceptSummaryAnswer
} from "./concept-summaries.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedderSource, FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";

const TIKTOK = "kc_tiktoktikt";
const SEO = "kc_seoseoseos";
const alex = "ke_alexalexale1";
const jason = "ke_jasonjasonj1";
const dan = "ke_dandandanda1";
const synth = "ke_synthsynths1";
const seoPost = "ke_seoseoseoso1";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kg-summaries-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FakeStore();
  store.collection(TIKTOK, "TikTok");
  store.collection(SEO, "SEO");
  store.put(alex, "Warm up the account: scroll the For You page, then post the first video after 1–2 days.", [TIKTOK], { title: "US TikTok in 10 steps", author: "Alex Nguyen", handle: "alexcooldev", kind: "post" }, true);
  store.put(jason, LONG_GUIDE.body, [TIKTOK], { title: LONG_GUIDE.title, author: "jason", handle: "jasonugc", kind: "post" }, true);
  store.put(dan, "Account warm-up: 3–5 days of scrolling before any upload.", [TIKTOK], { title: "Don't use NordVPN", author: null, handle: "danielhangan_", kind: "thread" }, true);
  store.put(synth, "Guides disagree on warm-up: 48h, 1–2, 3, 3–5 and 5–7 days.", [TIKTOK, SEO], { title: "US TikTok setup across guides", author: "Claude (research)", kind: "synthesis" }, true);
  store.put(seoPost, "Warm-up of a new domain before link building.", [SEO], { title: "Domain warm-up", kind: "post" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    [
      node("tactic-tiktok-account-warmup", "TikTok account warm-up", [alex, jason, dan, synth].map((id) => `${id}.md`), {
        type: "Tactic",
        aliases: ["Warm up the account"],
        description: "Scroll for a while, then post the first video after 1–2 days."
      }),
      node("tool-gmail", "Gmail", [`${jason}.md`, `${alex}.md`], { type: "Tool" }),
      node("term-warmup", "Warm-up", [`${alex}.md`, `${seoPost}.md`], { type: "Term" }),
      node("person-jason", "jason", [`${jason}.md`, `${synth}.md`], { type: "Person" }),
      node("metric-alone", "Views", [`${alex}.md`], { type: "Metric" })
    ],
    [edge("e1", "tactic-tiktok-account-warmup", "tool-gmail", [`${jason}.md`])]
  );
  const path = join(dir, "concept-summaries.json");
  const make = (extra: Partial<ConstructorParameters<typeof KnowledgeConceptSummaries>[0]> = {}) =>
    new KnowledgeConceptSummaries({
      path,
      concepts: () => graph.currentConcepts(),
      meta: (id) => store.getMeta(id),
      body: async (id) => (await store.getEntry(id))?.body ?? null,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      logger: silentLogger(),
      ...extra
    });
  return { dir, store, graph, path, make };
}

const answer = (value: unknown): string => JSON.stringify(value);

/** Answers a task: the warm-up's neutral text and the entries' own claims. */
function warmupAnswer(task: KnowledgeRoundTask): string {
  const inputs = (task.payload as { inputs: string[] }).inputs;
  return answer({
    text: "Using a new TikTok account normally (scrolling, watching) for a while before posting, so it looks like a real user.",
    positions: inputs.filter((id) => id !== synth).map((id) => ({ entryId: id, claim: id === alex ? "Post the first video after 1–2 days of scrolling." : "Warm up for 3–5 days before uploading." }))
  });
}

test("which concepts: 2+ entries that exist, no Person; claim-bearing types first, then two of its entries contradicting, then most entries", async (t) => {
  const { store, make } = await fixture(t);
  const summaries = make();
  await summaries.load();
  assert.deepEqual(
    summaries.due().map((d) => [d.conceptId, d.entries, d.tier]),
    [
      ["tactic-tiktok-account-warmup", 4, 2],
      ["tool-gmail", 2, 2],
      ["term-warmup", 2, 0]
    ]
  );
  // Two of its entries contradict each other: before the others of its tier, never before a claim type.
  const contested = make({ contradicting: () => [{ a: alex, b: seoPost }, { a: dan, b: synth }] });
  assert.deepEqual(
    contested.due().map((d) => [d.conceptId, d.tier]),
    [
      ["tactic-tiktok-account-warmup", 3],
      ["tool-gmail", 2],
      ["term-warmup", 1]
    ]
  );
  const gmailContested = make({ contradicting: () => [{ a: jason, b: alex }] });
  assert.deepEqual(
    gmailContested.due().map((d) => [d.conceptId, d.tier]),
    [
      ["tactic-tiktok-account-warmup", 3],
      ["tool-gmail", 3],
      ["term-warmup", 0]
    ],
    "within a tier, the most entries first"
  );
  // A deleted entry no longer counts: one left, none due.
  store.remove(seoPost);
  assert.ok(!summaries.due().some((d) => d.conceptId === "term-warmup"));
});

test("the task: the concept (its description marked as maybe one source's) and its entries naming it best, surveys last, a long one excerpted", async (t) => {
  const { make } = await fixture(t);
  const summaries = make({ limit: 1 });
  await summaries.load();
  const [task] = await summaries.tasks();
  assert.ok(task);
  assert.equal(task.label, `${CONCEPT_SUMMARY_STEP} tactic-tiktok-account-warmup`);
  assert.equal(task.system, CONCEPT_SUMMARY_SYSTEM);
  assert.match(task.user, /^CONCEPT\n=+\nType: Tactic\nName: TikTok account warm-up\nAliases: Warm up the account\nDescription \(may reflect one source only\): Scroll for a while/);
  assert.match(task.user, /ENTRIES \(4\)/);
  const order = [...task.user.matchAll(/^ENTRY (ke_\w+)$/gm)].map((m) => m[1]);
  assert.equal(order.at(-1), synth, "the survey last");
  assert.deepEqual((task.payload as { inputs: string[] }).inputs, order);
  assert.match(task.user, /ENTRY ke_alexalexale1\nTitle: US TikTok in 10 steps\nBy: Alex Nguyen @alexcooldev\nKind: post\nText:\nWarm up the account: scroll/);
  assert.match(task.user, /By: @danielhangan_\nKind: thread/);
  // The long guide: its opening and passages, not all of it.
  const guide = task.user.slice(task.user.indexOf(`ENTRY ${jason}`), task.user.indexOf("ENTRY", task.user.indexOf(`ENTRY ${jason}`) + 6));
  assert.ok(LONG_GUIDE.body.length > 4_000 && guide.length < 2_400, `excerpted (${guide.length} chars)`);
  assert.match(guide, /\[…\]/);
  assert.ok(task.user.length < 40_000, "one tool result");
  assert.match(CONCEPT_SUMMARY_SYSTEM, /no entry's numbers/);
  assert.match(CONCEPT_SUMMARY_SYSTEM, /Leave out an entry that only mentions the concept in passing/);
  // At most eight entries shown.
  const many = conceptSummaryInput(
    { type: "Tool", name: "Gmail", aliases: [], description: null },
    Array.from({ length: CONCEPT_SUMMARY_MAX_ENTRIES }, (_, i) => ({ id: `ke_${i}`, title: "", author: null, handle: null, kind: "", text: GMAIL_PASSAGE }))
  );
  assert.match(many, /ENTRIES \(8\)/);
  assert.match(many, /Title: \(untitled\)\nBy: unknown\nKind: note/);
});

test("answers: exactly {text, positions}; bounded; entry ids of the input, once; no entry's numbers in the text", () => {
  const ids = [alex, dan];
  const ok = { text: "Using a new account normally before posting.", positions: [{ entryId: alex, claim: "First video after 1–2 days." }] };
  assert.equal(validateConceptSummaryAnswer(ok, ids), null);
  assert.equal(validateConceptSummaryAnswer({ ...ok, positions: [] }, ids), null, "no entry makes a claim");
  assert.match(validateConceptSummaryAnswer([], ids)!, /JSON object/);
  assert.match(validateConceptSummaryAnswer({ ...ok, note: 1 }, ids)!, /only "text" and "positions"/);
  assert.match(validateConceptSummaryAnswer({ ...ok, text: " " }, ids)!, /"text"/);
  assert.match(validateConceptSummaryAnswer({ ...ok, text: "x".repeat(CONCEPT_SUMMARY_TEXT_MAX + 1) }, ids)!, /at most 400/);
  assert.match(validateConceptSummaryAnswer({ ...ok, text: "Posting the first video after 1–2 days." }, ids)!, /numbers \(1, 2\)/);
  assert.equal(validateConceptSummaryAnswer({ ...ok, text: "Apple's Guideline 4.3 on spam." }, ids, ["Guideline 4.3"]), null, "its own name's numbers");
  assert.match(validateConceptSummaryAnswer({ ...ok, positions: {} }, ids)!, /array/);
  assert.match(validateConceptSummaryAnswer({ ...ok, positions: [{ entryId: "ke_other", claim: "x" }] }, ids)!, /one of the entry ids given/);
  assert.match(validateConceptSummaryAnswer({ ...ok, positions: [ok.positions[0], ok.positions[0]] }, ids)!, /twice/);
  assert.match(validateConceptSummaryAnswer({ ...ok, positions: [{ entryId: alex, claim: "x".repeat(CONCEPT_SUMMARY_CLAIM_MAX + 1) }] }, ids)!, /at most 250/);
  assert.match(validateConceptSummaryAnswer({ ...ok, positions: [{ entryId: alex, claim: "x", why: 1 }] }, ids)!, /only "entryId" and "claim"/);
  assert.equal(parseConceptSummaryAnswer("not json", ids), null);
  assert.deepEqual(parseConceptSummaryAnswer(answer({ ...ok, text: "  Using  a new account.  " }), ids), { text: "Using a new account.", positions: ok.positions });
});

test("persistence: a summary is kept per concept with its members' hashes; asked again only when its entries change (an edit, a merge); a file it cannot read is moved aside", async (t) => {
  const { store, graph, path, make, dir } = await fixture(t);
  const summaries = make();
  await summaries.load();
  const tasks = await summaries.tasks();
  assert.deepEqual(tasks.map((task) => task.label.split(" ")[1]), ["tactic-tiktok-account-warmup", "tool-gmail", "term-warmup"]);
  const warmup = tasks[0]!;
  assert.match(summaries.validate(JSON.parse(answer({ text: "x", positions: [{ entryId: seoPost, claim: "y" }] })), warmup.payload)!, /one of the entry ids given/);
  await summaries.record(warmup.payload, warmupAnswer(warmup));
  await summaries.record(warmup.payload, "not json"); // ignored
  await summaries.record({ nonsense: true }, warmupAnswer(warmup)); // ignored
  const file = JSON.parse(await readFile(path, "utf8")) as { version: number; summaries: { conceptId: string; members: { id: string }[]; positions: unknown[] }[] };
  assert.equal(file.version, KNOWLEDGE_CONCEPT_SUMMARIES_VERSION);
  assert.deepEqual(file.summaries.map((s) => [s.conceptId, s.members.map((m) => m.id).sort(), s.positions.length]), [["tactic-tiktok-account-warmup", [alex, dan, jason, synth].sort(), 3]]);
  assert.ok(!summaries.due().some((d) => d.conceptId === "tactic-tiktok-account-warmup"), "written: not due");

  // Read back by a new instance: still not due.
  const again = make();
  await again.load();
  assert.ok(!again.due().some((d) => d.conceptId === "tactic-tiktok-account-warmup"));
  // An entry edited: due again (served meanwhile, without that entry's position).
  store.put(dan, "Account warm-up: a full week of scrolling before any upload.", [TIKTOK], { handle: "danielhangan_", kind: "thread" }, true);
  assert.ok(again.due().some((d) => d.conceptId === "tactic-tiktok-account-warmup"));
  // A merge folding another concept in changes its members too.
  const fresh = make();
  await fresh.load();
  store.put(dan, "Account warm-up: 3–5 days of scrolling before any upload.", [TIKTOK], { handle: "danielhangan_", kind: "thread" }, true);
  assert.ok(!fresh.due().some((d) => d.conceptId === "tactic-tiktok-account-warmup"), "the same content again: the same hash");
  graph.setConceptMerges([{ id: "cm_1", type: "Tactic", into: "tactic-tiktok-account-warmup", merged: ["term-warmup"], similarity: 0.95, createdAt: "t" }]);
  assert.ok(!fresh.due().some((d) => d.conceptId === "tactic-tiktok-account-warmup"), "another type is never merged in");
  await loadGraph(graph, [
    node("tactic-tiktok-account-warmup", "TikTok account warm-up", [alex, jason, dan, synth].map((id) => `${id}.md`), { type: "Tactic" }),
    node("tactic-warm-up-the-account", "Warm up the account", [`${seoPost}.md`], { type: "Tactic" })
  ]);
  graph.setConceptMerges([{ id: "cm_2", type: "Tactic", into: "tactic-tiktok-account-warmup", merged: ["tactic-warm-up-the-account"], similarity: 0.95, createdAt: "t" }]);
  assert.deepEqual(
    fresh.due().map((d) => [d.conceptId, d.entries]),
    [["tactic-tiktok-account-warmup", 5]],
    "the kept concept is written again with its new member"
  );

  await writeFile(path, "{ nope");
  const broken = make();
  await broken.load();
  assert.equal(broken.due().length, 1);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("concept-summaries.json.unreadable-")), "moved aside");
});

test("a newer build's file is read but never written; rounds that gave up on a concept skip to the next", async (t) => {
  const { path, make } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: KNOWLEDGE_CONCEPT_SUMMARIES_VERSION + 1, summaries: [] }));
  const newer = make();
  await newer.load();
  assert.deepEqual(await newer.tasks(), []);
  await rm(path);
  const summaries = make({ limit: 1 });
  await summaries.load();
  const [first] = await summaries.tasks();
  const [next] = await summaries.tasks({ skip: (task) => task.label === first!.label });
  assert.equal(next!.label, `${CONCEPT_SUMMARY_STEP} tool-gmail`);
});

test("visibility: a summary is served only to a caller who can see every entry it was written from, with the positions it can see; never a leak", async (t) => {
  const { store, graph, make } = await fixture(t);
  const summaries = make();
  await summaries.load();
  const [warmup] = await summaries.tasks();
  await summaries.record(warmup!.payload, warmupAnswer(warmup!));
  const indexDir = join(await mkdtemp(join(tmpdir(), "kg-summaries-index-")), "index");
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(null), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  search.connectConceptSummaries(summaries);

  const all = await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "all" });
  assert.deepEqual(all!.summary, {
    text: "Using a new TikTok account normally (scrolling, watching) for a while before posting, so it looks like a real user.",
    positions: [
      { entryId: alex, title: "US TikTok in 10 steps", author: "Alex Nguyen", claim: "Post the first video after 1–2 days of scrolling." },
      { entryId: jason, title: LONG_GUIDE.title, author: "jason", claim: "Warm up for 3–5 days before uploading." },
      { entryId: dan, title: "Don't use NordVPN", author: "@danielhangan_", claim: "Warm up for 3–5 days before uploading." }
    ].sort((a, b) => (warmupOrder(warmup!).indexOf(a.entryId) - warmupOrder(warmup!).indexOf(b.entryId)))
  });
  // A profile that sees TikTok sees every entry (the synthesis is in TikTok too): served.
  assert.ok((await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "collections", ids: [TIKTOK] }))!.summary);
  // The synthesis moved to SEO only: a TikTok-only caller cannot see one of the entries it was written from. Nothing of it.
  store.put(synth, "Guides disagree on warm-up: 48h, 1–2, 3, 3–5 and 5–7 days.", [SEO], { title: "US TikTok setup across guides", author: "Claude (research)", kind: "synthesis" }, true);
  const tiktokOnly = await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "collections", ids: [TIKTOK] });
  assert.ok(tiktokOnly, "the concept itself is visible");
  assert.equal(tiktokOnly.summary, undefined, "written from an entry it cannot see: left out whole");
  assert.ok(!JSON.stringify(tiktokOnly).includes("Using a new TikTok account normally"));
  assert.equal((await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "collections", ids: [SEO] }))?.summary, undefined);
  // Everything visible again, but an entry edited since: its position is left out, the rest served.
  store.put(synth, "Guides disagree on warm-up: 48h, 1–2, 3, 3–5 and 5–7 days.", [TIKTOK, SEO], { title: "US TikTok setup across guides", author: "Claude (research)", kind: "synthesis" }, true);
  store.put(alex, "Warm up for a week.", [TIKTOK], { title: "US TikTok in 10 steps", author: "Alex Nguyen", handle: "alexcooldev", kind: "post" }, true);
  const edited = await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "all" });
  assert.deepEqual(edited!.summary!.positions.map((p) => p.entryId).sort(), [dan, jason].sort());
  // Every position gone (edited): left out.
  store.put(dan, "x", [TIKTOK], { handle: "danielhangan_", kind: "thread" }, true);
  store.put(jason, "y", [TIKTOK], { author: "jason", kind: "post" }, true);
  assert.equal((await search.conceptDetail("tactic-tiktok-account-warmup", { kind: "all" }))!.summary, undefined);
  // A deleted member: left out.
  const other = make();
  await other.load();
  const [gmail] = (await other.tasks()).filter((task) => task.label.endsWith("tool-gmail"));
  await other.record(gmail!.payload, answer({ text: "Google's email service.", positions: [] }));
  search.connectConceptSummaries(other);
  assert.deepEqual((await search.conceptDetail("tool-gmail", { kind: "all" }))!.summary, { text: "Google's email service.", positions: [] });
  store.remove(alex);
  assert.equal((await search.conceptDetail("tool-gmail", { kind: "all" }))?.summary, undefined);
});

/** The order the task listed its entries in (positions keep the answer's order). */
function warmupOrder(task: KnowledgeRoundTask): string[] {
  return (task.payload as { inputs: string[] }).inputs;
}
