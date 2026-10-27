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

  it("finds the entry by its whole mirror text, or by a window of a long one; null when none or ambiguous", async () => {
    const { put, store } = await setup();
    const long = `# Long\n\n${"Paragraph about alternatives pages and competitors. ".repeat(80)}\nThe middle part says 48-hour windows matter.\n${"Closing words. ".repeat(80)}`;
    await put("ke_a", "Author: A\n\n# Short\n\nOne line.\n");
    await put("ke_long", long);
    await put("ke_dup1", "Shared start of text that is the same in two entries. Then one.");
    await put("ke_dup2", "Shared start of text that is the same in two entries. Then two.");
    const locator = new EntryDocumentLocator(store);
    assert.equal(await locator.entryOf(prompt("Author: A\n\n# Short\n\nOne line.")), "ke_a", "myKG strips the trailing newline");
    const window = long.slice(long.indexOf("The middle part"), long.indexOf("The middle part") + 600);
    assert.equal(await locator.entryOf(prompt(window)), "ke_long");
    assert.equal(await locator.entryOf("Previous attempt had errors:\n- x\n\n" + prompt("Author: A\n\n# Short\n\nOne line.")), "ke_a", "a retry prompt");
    assert.equal(await locator.entryOf(prompt("Shared start of text that is the same in two entries.")), null, "ambiguous");
    assert.equal(await locator.entryOf(prompt("Nobody wrote this.")), null);
    assert.equal(await locator.entryOf("CORPUS without a document"), null);
    // Saved after the mirrors were first read: found on the miss.
    await put("ke_new", "A brand new entry.");
    assert.equal(await locator.entryOf(prompt("A brand new entry.")), "ke_new");
    assert.equal(documentOf(prompt("x")), "x");
  });

  it("the run's provider gives Pass 2 tasks their entry's block, other steps none", async () => {
    const { put, store } = await setup();
    await put("ke_t", "Target text.");
    const index = corpus();
    const v = view(index, { ke_n1: [ref("Tactic", "Alternatives pages")] });
    const provider = linkContextProvider(store, v);
    const envelope = (step: string, user: string): InboxTaskEnvelope => ({ task_id: "x", step, context_label: `${step} 1`, system: "S", user, max_tokens: 1, timeout_seconds: 0, created_at: "" });
    assert.match((await provider(envelope("pass2", prompt("Target text.")))) ?? "", /- Tactic: Alternatives pages/);
    assert.equal(await provider(envelope("pass1", prompt("Target text."))), null);
    assert.equal(await provider(envelope("normalize_names", prompt("Target text."))), null);
    assert.equal(await provider(envelope("pass2", prompt("Unknown text."))), null);
  });
});
