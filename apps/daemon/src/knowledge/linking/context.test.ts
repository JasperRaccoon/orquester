import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeConceptRef, KnowledgeEntryMeta } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import {
  CONTEXT_CONCEPTS_MAX,
  CONTEXT_HEADING,
  documentOf,
  EntryDocumentLocator,
  linkContextProvider,
  nearestNeighbours,
  neighbourContextBlock,
  WINDOW_MIN_CHARS,
  type KnowledgeLinkGraphView
} from "./context.ts";
import type { InboxTaskEnvelope } from "./inbox.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const DIMS = 16;
const ref = (type: string, name: string): KnowledgeConceptRef => ({ id: `${type.toLowerCase()}-${name.toLowerCase().replace(/\W+/g, "-")}`, type, name });

function view(index: FakeVectorIndex, concepts: Record<string, KnowledgeConceptRef[]>): KnowledgeLinkGraphView {
  return { vectors: () => index, conceptsOf: (id) => concepts[id] ?? [], contradicting: () => [] };
}

/** ke_t and seven entries around it, closest first: n1 (0.99) … n7 (0.9); `far` is unrelated. */
function corpus() {
  const index = new FakeVectorIndex();
  index.set("ke_t", axis(DIMS, 0));
  const sims = [0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.9];
  sims.forEach((cos, i) => index.set(`ke_n${i + 1}`, around(DIMS, 0, i + 1, cos)));
  index.set("ke_far", axis(DIMS, 15));
  return index;
}

describe("nearestNeighbours / neighbourContextBlock", () => {
  it("lists the concepts of the 5 nearest neighbours that have any, shared ones first, as `type: name` after a heading", () => {
    const index = corpus();
    const shared = ref("Tactic", "Alternatives pages");
    const concepts: Record<string, KnowledgeConceptRef[]> = {
      ke_t: [ref("Tactic", "Own concept")],
      ke_n1: [], // nearest, but nothing to offer: skipped
      ke_n2: [ref("Tool", "Ahrefs"), shared],
      ke_n3: [shared, ref("Metric", "Conversion rate")],
      ke_n4: [ref("Person", "Om Patel")],
      ke_n5: [ref("Rule", "One page per competitor")],
      ke_n6: [ref("Result", "2x signups")],
      ke_n7: [ref("Tool", "Too far down")], // the 6th neighbour with concepts
      ke_far: [ref("Tool", "Unrelated")]
    };
    const v = view(index, concepts);
    assert.deepEqual(
      nearestNeighbours(index, "ke_t", 5, 0.3, (id) => (concepts[id] ?? []).length > 0).map((n) => n.entryId),
      ["ke_n2", "ke_n3", "ke_n4", "ke_n5", "ke_n6"]
    );
    const block = neighbourContextBlock("ke_t", v)!;
    const lines = block.split("\n");
    assert.equal(lines[0], CONTEXT_HEADING);
    assert.match(block, /reuse|exactly this type and name/);
    assert.match(block, /Never extract a listed concept the document does not mention\./);
    const listed = lines.filter((line) => line.startsWith("- "));
    assert.deepEqual(listed, [
      "- Tactic: Alternatives pages",
      "- Tool: Ahrefs",
      "- Metric: Conversion rate",
      "- Person: Om Patel",
      "- Rule: One page per competitor",
      "- Result: 2x signups"
    ]);
    assert.ok(!block.includes("Unrelated") && !block.includes("Too far down") && !block.includes("Own concept"));
  });

  it("caps the list at 40 concepts, and has nothing to say without neighbours, vectors or a model", () => {
    const index = corpus();
    const many: Record<string, KnowledgeConceptRef[]> = {};
    for (let i = 1; i <= 5; i += 1) many[`ke_n${i}`] = Array.from({ length: 12 }, (_, j) => ref("Tactic", `n${i} concept ${j}`));
    const block = neighbourContextBlock("ke_t", view(index, many))!;
    assert.equal(block.split("\n").filter((line) => line.startsWith("- ")).length, CONTEXT_CONCEPTS_MAX);
    assert.equal(neighbourContextBlock("ke_t", view(index, {})), null, "no neighbour has concepts");
    assert.equal(neighbourContextBlock("ke_missing", view(index, many)), null, "no vectors for the entry");
    index.limits = null;
    assert.equal(neighbourContextBlock("ke_t", view(index, many)), null, "no model");
  });
});

describe("EntryDocumentLocator", () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "orq-context-"));
    roots.push(dir);
    const metas: Pick<KnowledgeEntryMeta, "id">[] = [];
    const put = async (id: string, text: string) => {
      await writeFile(join(dir, `${id}.md`), text);
      if (!metas.some((m) => m.id === id)) metas.push({ id });
    };
    const store = { mykgInputDir: dir, listMeta: () => metas as KnowledgeEntryMeta[] };
    return { dir, put, store };
  }

  const prompt = (document: string) => `SCHEMA\n======\n- Tactic\n\nNODES ALREADY EXTRACTED\n========================\n\nDOCUMENT\n========\n${document}`;

  /** A mirror longer than a chunk: numbered paragraphs, so every slice of it is unique. */
  const longMirror = (tag: string, paragraphs = 300) =>
    `Author: A\n\n# Long ${tag}\n\n${Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i} of ${tag} says the warm-up takes ${i} days.`).join("\n\n")}\n`;

  it("finds the entry by its whole mirror text, or by myKG's chunk windows of a long one; null when none or ambiguous", async () => {
    const { put, store } = await setup();
    const long = longMirror("one");
    assert.ok(long.length > 4 * WINDOW_MIN_CHARS);
    await put("ke_a", "Author: A\n\n# Short\n\nOne line.\n");
    await put("ke_long", long);
    await put("ke_dup1", "Same text in two entries.\n");
    await put("ke_dup2", "Same text in two entries.\n");
    const locator = new EntryDocumentLocator(store);
    assert.equal(await locator.entryOf(prompt("Author: A\n\n# Short\n\nOne line.")), "ke_a", "myKG strips the trailing newline");
    assert.equal(await locator.entryOf("Previous attempt had errors:\n- x\n\n" + prompt("Author: A\n\n# Short\n\nOne line.")), "ke_a", "a retry prompt");
    const at = (n: number) => long.indexOf(`Paragraph ${n} of`);
    // The first window starts at the mirror's start; a middle one anywhere; the last ends at its end.
    assert.equal(await locator.entryOf(prompt(long.slice(0, WINDOW_MIN_CHARS + 500))), "ke_long", "the first window");
    assert.equal(await locator.entryOf(prompt(long.slice(at(100) + 7, at(100) + 7 + WINDOW_MIN_CHARS + 10))), "ke_long", "a middle window, cut mid-word");
    assert.equal(await locator.entryOf(prompt(long.slice(at(290)))), "ke_long", "the last window, shorter than a full one");
    // Two windows of one batch: joined by a blank line, the second starting inside the first.
    const first = long.slice(0, at(80));
    const second = long.slice(at(70) + 3, at(150));
    assert.equal(await locator.entryOf(prompt(`${first}\n\n${second}`)), "ke_long", "two overlapping windows in one batch");
    assert.equal(await locator.entryOf(prompt(`${first}\n\n${long.slice(at(90), at(170))}`)), null, "windows that do not overlap are not myKG's");
    // A window cut inside a character carries a replacement character at its edges.
    assert.equal(await locator.entryOf(prompt(`\ufffd${long.slice(at(120) + 1, at(200))}\ufffd`)), "ke_long");
    // Not a window: shorter than a full one, neither the mirror's start nor its end.
    assert.equal(await locator.entryOf(prompt(long.slice(at(150), at(150) + 600))), null, "a quote, not a window");
    assert.equal(await locator.entryOf(prompt(long.slice(at(10), at(60)).replace("says", "said"))), null, "a window must match whole");
    assert.equal(await locator.entryOf(prompt("Same text in two entries.")), null, "ambiguous");
    assert.equal(await locator.entryOf(prompt("Nobody wrote this.")), null);
    assert.equal(await locator.entryOf("CORPUS without a document"), null);
    assert.equal(documentOf(prompt("x")), "x");
  });

  it("an entry quoted whole inside a long one is still its own; windows two entries share are ambiguous", async () => {
    const { put, store } = await setup();
    const long = longMirror("two");
    const quoted = long.slice(long.indexOf("Paragraph 40 of"), long.indexOf("Paragraph 42 of")).trim();
    await put("ke_long", long);
    await put("ke_quote", `${quoted}\n`);
    await put("ke_copy", long.slice(0, long.indexOf("Paragraph 200 of")));
    const locator = new EntryDocumentLocator(store);
    assert.equal(await locator.entryOf(prompt(quoted)), "ke_quote", "its whole mirror first");
    assert.equal(await locator.entryOf(prompt(long.slice(0, WINDOW_MIN_CHARS + 100))), null, "the first window of either");
    assert.equal(await locator.entryOf(prompt(long.slice(long.indexOf("Paragraph 250 of")))), "ke_long", "only the longer one has it");
  });

  it("reads the mirrors once, and again at most once on a miss", async () => {
    const { put, store } = await setup();
    await put("ke_a", "First entry.\n");
    let reads = 0;
    const counted = { ...store, listMeta: () => (reads += 1, store.listMeta()) };
    const locator = new EntryDocumentLocator(counted);
    assert.equal(await locator.entryOf(prompt("First entry.")), "ke_a");
    assert.equal(await locator.entryOf(prompt("First entry.")), "ke_a");
    assert.equal(reads, 1);
    // Saved after the mirrors were read: found on the first miss, which reads them again.
    await put("ke_new", "A brand new entry.\n");
    assert.equal(await locator.entryOf(prompt("A brand new entry.")), "ke_new");
    assert.equal(reads, 2);
    await put("ke_newer", "Another one.\n");
    assert.equal(await locator.entryOf(prompt("Another one.")), null, "no second reload in the run");
    assert.equal(await locator.entryOf(prompt("Nobody wrote this.")), null);
    assert.equal(reads, 2);
  });

  it("the run's provider gives Pass 2 tasks their entry's block, other steps none", async () => {
    const { put, store } = await setup();
    await put("ke_t", "Target text.");
    const index = corpus();
    const v = view(index, { ke_n1: [ref("Tactic", "Alternatives pages")] });
    const provider = linkContextProvider(store, v);
    const envelope = (step: string, user: string): InboxTaskEnvelope => ({ task_id: `${step} ${user}`, step, context_label: `${step} 1`, system: "S", user, max_tokens: 1, timeout_seconds: 0, created_at: "" });
    assert.match((await provider(envelope("pass2", prompt("Target text.")))) ?? "", /- Tactic: Alternatives pages/);
    assert.equal(await provider(envelope("pass1", prompt("Target text."))), null);
    assert.equal(await provider(envelope("normalize_names", prompt("Target text."))), null);
    assert.equal(await provider(envelope("pass2", prompt("Unknown text."))), null);
  });

  it("computes a task's block once, whatever how often the task is handed out", async () => {
    const { put, store } = await setup();
    await put("ke_t", "Target text.");
    const index = corpus();
    let reads = 0;
    const v: KnowledgeLinkGraphView = {
      vectors: () => index,
      conceptsOf: (id) => {
        reads += 1;
        return id === "ke_n1" ? [ref("Tactic", "Alternatives pages")] : [];
      },
      contradicting: () => []
    };
    const provider = linkContextProvider(store, v);
    const task: InboxTaskEnvelope = { task_id: "t1", step: "pass2", context_label: "pass2 chunk 1", system: "S", user: prompt("Target text."), max_tokens: 1, timeout_seconds: 0, created_at: "" };
    const first = await provider(task);
    const once = reads;
    assert.ok(once > 0);
    assert.equal(await provider(task), first);
    assert.equal(await provider({ ...task }), first);
    assert.equal(reads, once, "the block is not computed again");
  });
});
