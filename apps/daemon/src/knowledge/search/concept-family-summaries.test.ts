import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KNOWLEDGE_CONCEPT_FAMILIES_VERSION } from "@orquester/config";
import { LONG_GUIDE } from "../linking/fixtures/tiktok-guides.ts";
import type { KnowledgeRoundTask } from "../ports.ts";
import { conceptFamilyId, type ConceptFamily } from "./concept-families.ts";
import {
  FAMILY_FALLBACK_NAME,
  FAMILY_SUMMARY_MAX_ENTRIES,
  FAMILY_SUMMARY_STEP,
  FAMILY_SUMMARY_SYSTEM,
  KnowledgeConceptFamilySummaries,
  familySummaryInput,
  parseFamilySummaryAnswer,
  validateFamilySummaryAnswer
} from "./concept-family-summaries.ts";
import { ATTRIBUTED_NOTE } from "./concept-summaries.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSearch } from "./search.ts";
import { FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";

const TIKTOK = "kc_tiktoktikt";
const SEO = "kc_seoseoseos";
const jason = "ke_jasonjasonj1";
const yanme = "ke_yanmeyanmey1";
const evgeniy = "ke_evgeniyevge1";
const ema = "ke_emaemaemaem1";
const alex = "ke_alexalexale1";
const synth = "ke_synthsynths1";
const erikas = "ke_erikaserika1";

const MEMBERS = ["tactic-warm-48", "tactic-warm-3", "tactic-warm-35", "tactic-warm-57", "tactic-tiktok-warmup"];

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kg-families-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FakeStore();
  store.collection(TIKTOK, "TikTok");
  store.collection(SEO, "SEO");
  store.put(jason, LONG_GUIDE.body, [TIKTOK], { title: LONG_GUIDE.title, author: "jason", handle: "jasonugc", kind: "post" }, true);
  store.put(yanme, "Warm up each account for 3 days before the first post.", [TIKTOK], { title: "$300 app start", author: "yanme", handle: "wbyanme", kind: "post" }, true);
  store.put(evgeniy, "3-5 days of warming up, then post.", [TIKTOK], { title: "My TikTok setup", author: "Evgeniy Mikholap", kind: "post" }, true);
  store.put(ema, "Warm up the TikTok account for 5-7 days.", [TIKTOK], { title: "US TikTok from Italy", author: "Emanuele Totaro", kind: "post" }, true);
  store.put(alex, "Warm up the account: scroll the For You page, then post the first video after 1–2 days.", [TIKTOK], { title: "US TikTok in 10 steps", author: "Alex Nguyen", kind: "post" }, true);
  store.put(synth, "Guides disagree on warm-up: 48h, 1–2, 3, 3–5 and 5–7 days.", [TIKTOK], { title: "US TikTok setup across guides", author: "Claude (research)", kind: "synthesis" }, true);
  store.put(erikas, "Swipe TikToks 15-30 minutes a day with an occasional like.", [TIKTOK], { title: "Erikas's guide", author: "Erikas", kind: "post" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(graph, [
    node("tactic-warm-48", "Warm up the account for 48 hours before posting", [`${jason}.md`], { type: "Tactic" }),
    node("tactic-warm-3", "Warm up each account for 3 days", [`${yanme}.md`], { type: "Tactic" }),
    node("tactic-warm-35", "3-5 days of warming up", [`${evgeniy}.md`], { type: "Tactic" }),
    node("tactic-warm-57", "Warm up the TikTok account for 5-7 days", [`${ema}.md`], { type: "Tactic" }),
    node("tactic-tiktok-warmup", "TikTok account warm-up", [`${alex}.md`, `${synth}.md`], { type: "Tactic" }),
    node("tactic-warm-swipe", "Swipe 15-30 min a day", [`${erikas}.md`], { type: "Tactic" })
  ]);
  let families: ConceptFamily[] = [familyOf(MEMBERS)];
  const port = {
    families: () => families,
    family: (id: string) => families.find((family) => family.concepts.includes(id)) ?? null
  };
  const path = join(dir, "concept-families.json");
  const make = (extra: Partial<ConstructorParameters<typeof KnowledgeConceptFamilySummaries>[0]> = {}) =>
    new KnowledgeConceptFamilySummaries({
      path,
      families: port,
      concepts: () => graph.currentConcepts(),
      meta: (id) => store.getMeta(id),
      body: async (id) => (await store.getEntry(id))?.body ?? null,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      logger: silentLogger(),
      ...extra
    });
  return { dir, store, graph, path, make, setFamilies: (next: ConceptFamily[]) => (families = next) };
}

function familyOf(concepts: string[]): ConceptFamily {
  return { id: conceptFamilyId("Tactic", concepts), type: "Tactic", concepts, entryIds: [] };
}

const answer = (value: unknown): string => JSON.stringify(value);

const CLAIMS: Record<string, string> = {
  [jason]: "Warm up for 48 hours before the first post.",
  [yanme]: "Warm up each account for 3 days.",
  [evgeniy]: "Warm up for 3–5 days.",
  [ema]: "Warm up for 5–7 days.",
  [alex]: "Post the first video after 1–2 days of scrolling.",
  [synth]: "Reports that guides disagree: 48 hours to 7 days.",
  [erikas]: "Swipe 15–30 minutes a day."
};

/** Answers a task: the question, a neutral text and every entry's own answer. */
function warmupAnswer(task: KnowledgeRoundTask): string {
  const inputs = (task.payload as { inputs: string[] }).inputs;
  return answer({ name: "Warm-up length before the first post", text: "How long a new account is used like a real user's before it posts.", positions: inputs.map((id) => ({ entryId: id, claim: CLAIMS[id] })) });
}

test("the task: the family's members and every member's entries, each with the members it backs; surveys last; bounded", async (t) => {
  const { make } = await fixture(t);
  const summaries = make();
  await summaries.load();
  const [task] = await summaries.tasks();
  assert.ok(task);
  assert.equal(task.label, `${FAMILY_SUMMARY_STEP} ${conceptFamilyId("Tactic", MEMBERS)}`);
  assert.equal(task.system, FAMILY_SUMMARY_SYSTEM);
  assert.ok(
    task.user.startsWith(
      [
        "FAMILY",
        "======",
        "Type: Tactic",
        "Concepts (5), each one way of answering the question:",
        "- Warm up the account for 48 hours before posting",
        "- Warm up each account for 3 days",
        "- 3-5 days of warming up",
        "- Warm up the TikTok account for 5-7 days",
        "- TikTok account warm-up",
        "",
        "ENTRIES (6)"
      ].join("\n")
    ),
    task.user.slice(0, 400)
  );
  const order = [...task.user.matchAll(/^ENTRY (ke_\w+)$/gm)].map((m) => m[1]);
  assert.equal(order.length, 6);
  assert.equal(order.at(-1), synth, "the survey last");
  assert.deepEqual((task.payload as { inputs: string[] }).inputs, order);
  assert.ok(task.user.includes(`ENTRY ${yanme}\nTitle: $300 app start\nBy: yanme @wbyanme\nKind: post\nBacks: Warm up each account for 3 days\nText:\nWarm up each account for 3 days before the first post.`));
  assert.ok(task.user.includes(`ENTRY ${synth}\nTitle: US TikTok setup across guides\nBy: Claude (research)\nKind: synthesis\nBacks: TikTok account warm-up\n`));
  // The long guide: excerpted.
  const guide = task.user.slice(task.user.indexOf(`ENTRY ${jason}`), task.user.indexOf("ENTRY", task.user.indexOf(`ENTRY ${jason}`) + 6));
  assert.ok(guide.length < 2_000, `excerpted (${guide.length} chars)`);
  assert.match(FAMILY_SUMMARY_SYSTEM, /3 to 8 words/);
  assert.match(FAMILY_SUMMARY_SYSTEM, /no entry's numbers/);
  // At most twelve entries.
  const many = familySummaryInput(
    { type: "Tactic", concepts: ["a b c", "d e f"] },
    Array.from({ length: FAMILY_SUMMARY_MAX_ENTRIES }, (_, i) => ({ id: `ke_${i}`, title: "", author: null, handle: null, kind: "", backs: [], text: "x" }))
  );
  assert.match(many, /ENTRIES \(12\)/);
  assert.match(many, /Title: \(untitled\)\nBy: unknown\nKind: note\nText:/);
});

test("the task reads an author's own entry attributed to a member, saying so", async (t) => {
  const { make } = await fixture(t);
  const summaries = make({ attributed: () => new Map([["tactic-warm-3", [{ entryId: erikas, personId: "person-erikas", basis: [synth] }]]]) });
  await summaries.load();
  const [task] = await summaries.tasks();
  const payload = task!.payload as { inputs: string[]; attributed: string[]; members: { id: string }[] };
  assert.ok(payload.inputs.includes(erikas));
  assert.deepEqual(payload.attributed, [erikas]);
  assert.ok(task!.user.includes(`ENTRY ${erikas}\nTitle: Erikas's guide\nBy: Erikas\nKind: post\nBacks: Warm up each account for 3 days\n${ATTRIBUTED_NOTE}\nText:`));
  assert.deepEqual(payload.members.map((m) => m.id).sort(), [alex, ema, erikas, evgeniy, jason, synth, yanme].sort());
});

test("answers: exactly {name, text, positions}; a 3–8 word question with no answer's numbers; bounded; entry ids of the input, once", () => {
  const ids = [jason, yanme];
  const names = ["Warm up the account for 48 hours before posting", "Warm up each account for 3 days"];
  const ok = { name: "Warm-up length before the first post", text: "How long a new account is used normally before posting.", positions: [{ entryId: jason, claim: "48 hours." }] };
  assert.equal(validateFamilySummaryAnswer(ok, ids, names), null);
  assert.equal(validateFamilySummaryAnswer({ ...ok, positions: [] }, ids, names), null);
  assert.match(validateFamilySummaryAnswer([], ids)!, /JSON object/);
  assert.match(validateFamilySummaryAnswer({ ...ok, note: 1 }, ids)!, /only "name", "text" and "positions"/);
  assert.match(validateFamilySummaryAnswer({ ...ok, name: "Warm-up" }, ids)!, /3 to 8 words/);
  assert.match(validateFamilySummaryAnswer({ ...ok, name: "How long to warm up a brand new TikTok account before posting" }, ids)!, /3 to 8 words/);
  assert.match(validateFamilySummaryAnswer({ ...ok, name: "Warm up for 48 hours" }, ids, names)!, /"name" must not carry an entry's numbers \(48\)/);
  assert.match(validateFamilySummaryAnswer({ ...ok, text: "Between 48 hours and 7 days." }, ids, names)!, /"text" must not carry an entry's numbers \(48, 7\)/);
  assert.equal(validateFamilySummaryAnswer({ ...ok, text: "What Guideline 4.3 asks." }, ids, ["Guideline 4.3(a)", "Guideline 4.3(b)"]), null, "a number every member name has");
  assert.match(validateFamilySummaryAnswer({ ...ok, positions: [{ entryId: "ke_other", claim: "x" }] }, ids)!, /one of the entry ids given/);
  assert.match(validateFamilySummaryAnswer({ ...ok, positions: [ok.positions[0], ok.positions[0]] }, ids)!, /twice/);
  assert.equal(parseFamilySummaryAnswer("not json", ids), null);
  assert.deepEqual(parseFamilySummaryAnswer(answer({ ...ok, name: "  Warm-up length before  the first post. " }), ids, names), { ...ok, name: "Warm-up length before the first post" });
});

test("persistence: one record per family with its members and entries; asked again when an entry or the members change; a changed family's record replaces the old", async (t) => {
  const { store, path, make, dir, setFamilies } = await fixture(t);
  const summaries = make();
  await summaries.load();
  const [task] = await summaries.tasks();
  await summaries.record(task!.payload, warmupAnswer(task!));
  await summaries.record(task!.payload, "not json"); // ignored
  await summaries.record({ nonsense: true }, warmupAnswer(task!)); // ignored
  const file = JSON.parse(await readFile(path, "utf8")) as { version: number; families: { familyId: string; concepts: string[]; name: string; positions: unknown[] }[] };
  assert.equal(file.version, KNOWLEDGE_CONCEPT_FAMILIES_VERSION);
  assert.deepEqual(
    file.families.map((f) => [f.familyId, f.concepts, f.name, f.positions.length]),
    [[conceptFamilyId("Tactic", MEMBERS), MEMBERS, "Warm-up length before the first post", 6]]
  );
  assert.deepEqual(summaries.due(), [], "written: not due");
  const again = make();
  await again.load();
  assert.deepEqual(again.due(), []);
  // An entry edited: due again.
  store.put(ema, "Warm up the TikTok account for a week.", [TIKTOK], { title: "US TikTok from Italy", author: "Emanuele Totaro", kind: "post" }, true);
  assert.equal(again.due().length, 1);
  store.put(ema, "Warm up the TikTok account for 5-7 days.", [TIKTOK], { title: "US TikTok from Italy", author: "Emanuele Totaro", kind: "post" }, true);
  assert.deepEqual(again.due(), [], "the same content again: the same hash");
  // A member joins (the family keeps its id: its first member stays): due, and its record replaces the old one.
  const grown = [...MEMBERS, "tactic-warm-swipe"];
  setFamilies([familyOf(grown)]);
  assert.equal(conceptFamilyId("Tactic", grown), conceptFamilyId("Tactic", MEMBERS));
  assert.deepEqual(again.due().map((d) => d.concepts.length), [6]);
  // Another family that took a member is written: the old record goes too.
  setFamilies([familyOf(["tactic-warm-swipe", "tactic-warm-3"])]);
  const [other] = await again.tasks();
  await again.record(other!.payload, answer({ name: "Daily scrolling during the warm-up", text: "How much to scroll.", positions: [] }));
  const after = JSON.parse(await readFile(path, "utf8")) as { families: { concepts: string[] }[] };
  assert.deepEqual(after.families.map((f) => f.concepts), [["tactic-warm-swipe", "tactic-warm-3"]]);

  await writeFile(path, "{ nope");
  const broken = make();
  await broken.load();
  assert.equal(broken.due().length, 1);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("concept-families.json.unreadable-")), "moved aside");
});

test("a newer build's file is read but never written; rounds that gave up on a family skip to the next", async (t) => {
  const { path, make, setFamilies } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: KNOWLEDGE_CONCEPT_FAMILIES_VERSION + 1, families: [] }));
  const newer = make();
  await newer.load();
  assert.deepEqual(await newer.tasks(), []);
  await rm(path);
  setFamilies([familyOf(MEMBERS), familyOf(["tactic-warm-swipe", "tactic-zzz-missing"])]);
  const summaries = make({ limit: 1 });
  await summaries.load();
  const [first] = await summaries.tasks();
  assert.ok(first);
  // The other family has one concept left in the graph: never due. So nothing after the first.
  assert.deepEqual(await summaries.tasks({ skip: (task) => task.label === first.label }), []);
});

test("visibility: the family on every member's detail; its name and summary only for a caller who can see every entry, members only those it can see; never a leak", async (t) => {
  const { store, graph, make, setFamilies } = await fixture(t);
  const summaries = make();
  await summaries.load();
  const [task] = await summaries.tasks();
  await summaries.record(task!.payload, warmupAnswer(task!));
  const indexDir = join(await mkdtemp(join(tmpdir(), "kg-families-index-")), "index");
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(null), indexDir, logger: silentLogger() });
  t.after(async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  });
  await search.start();
  search.connectConceptFamilies(summaries);

  for (const id of MEMBERS) {
    const detail = await search.conceptDetail(id, { kind: "all" });
    assert.equal(detail!.family?.name, "Warm-up length before the first post", id);
    assert.deepEqual(detail!.family!.concepts.map((c) => c.id), MEMBERS);
  }
  const all = (await search.conceptDetail("tactic-warm-3", { kind: "all" }))!.family!;
  assert.equal(all.id, conceptFamilyId("Tactic", MEMBERS));
  assert.equal(all.summary!.text, "How long a new account is used like a real user's before it posts.");
  // The position of the entry behind the concept read first (yanme's), then the others as written.
  const inputs = (task!.payload as { inputs: string[] }).inputs;
  assert.deepEqual(
    all.summary!.positions.map((p) => [p.entryId, p.author, p.claim]),
    [yanme, ...inputs.filter((id) => id !== yanme)].map((id) => [id, store.getMeta(id)!.author, CLAIMS[id]])
  );
  // On every member: its own entries' positions first (Alex's and the synthesis's on the shared warm-up concept).
  const behind: Record<string, string[]> = { "tactic-warm-48": [jason], "tactic-warm-3": [yanme], "tactic-warm-35": [evgeniy], "tactic-warm-57": [ema], "tactic-tiktok-warmup": [alex, synth] };
  for (const [id, own] of Object.entries(behind)) {
    const positions = (await search.conceptDetail(id, { kind: "all" }))!.family!.summary!.positions.map((p) => p.entryId);
    assert.equal(positions.length, inputs.length, id);
    assert.deepEqual(new Set(positions.slice(0, own.length)), new Set(own), id);
    assert.deepEqual(positions.slice(own.length), inputs.filter((entryId) => !own.includes(entryId)), id);
  }
  assert.equal((await search.conceptDetail("tactic-warm-swipe", { kind: "all" }))!.family, undefined, "no family");

  // Ema's guide moves to SEO: a TikTok-only caller cannot see her concept, nor one entry the family was written from.
  store.put(ema, "Warm up the TikTok account for 5-7 days.", [SEO], { title: "US TikTok from Italy", author: "Emanuele Totaro", kind: "post" }, true);
  const scoped = (await search.conceptDetail("tactic-warm-3", { kind: "collections", ids: [TIKTOK] }))!;
  assert.deepEqual(scoped.family, {
    id: conceptFamilyId("Tactic", MEMBERS),
    name: FAMILY_FALLBACK_NAME,
    concepts: MEMBERS.filter((id) => id !== "tactic-warm-57").map((id) => ({ id, name: graph.currentConcepts().find((c) => c.id === id)!.name, type: "Tactic" }))
  });
  const text = JSON.stringify(scoped);
  for (const leak of ["Warm-up length", "like a real user", "5–7 days", "Warm up the TikTok account for 5-7 days"]) assert.ok(!text.includes(leak), leak);
  assert.equal(await search.conceptDetail("tactic-warm-57", { kind: "collections", ids: [TIKTOK] }), null, "her concept is hidden whole");
  // Only one member visible: no family at all.
  for (const id of [jason, yanme, evgeniy, synth]) store.put(id, (await store.getEntry(id))!.body, [SEO], { ...store.getMeta(id)!, collections: [SEO] }, true);
  assert.equal((await search.conceptDetail("tactic-tiktok-warmup", { kind: "collections", ids: [TIKTOK] }))!.family, undefined);

  // Everything visible again, but Alex's post edited since: its position is left out, the rest served.
  for (const id of [jason, yanme, evgeniy, synth, ema]) store.put(id, (await store.getEntry(id))!.body, [TIKTOK], { ...store.getMeta(id)!, collections: [TIKTOK] }, true);
  store.put(alex, "Warm up for a week.", [TIKTOK], { title: "US TikTok in 10 steps", author: "Alex Nguyen", kind: "post" }, true);
  const edited = (await search.conceptDetail("tactic-warm-48", { kind: "all" }))!.family!;
  assert.equal(edited.name, "Warm-up length before the first post");
  assert.ok(!edited.summary!.positions.some((p) => p.entryId === alex));
  assert.equal(edited.summary!.positions.length, 5);
  // The family changed (a member left): its record was written for other members. The fallback, until written again.
  setFamilies([familyOf(MEMBERS.slice(0, 4))]);
  const changed = (await search.conceptDetail("tactic-warm-48", { kind: "all" }))!.family!;
  assert.equal(changed.name, FAMILY_FALLBACK_NAME);
  assert.equal(changed.summary, undefined);
});
