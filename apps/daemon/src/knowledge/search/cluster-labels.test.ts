import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { knowledgeCitation, type KnowledgeVisibility } from "@orquester/api";
import {
  CLUSTER_NAME_MAX_PER_ROUND,
  CLUSTER_NAME_STEP,
  CLUSTER_NAME_SYSTEM,
  KnowledgeClusterLabels,
  clusterKey,
  clusterNameInput,
  parseClusterLabelAnswer,
  validateClusterLabelAnswer,
  type ClusterDescription
} from "./cluster-labels.ts";
import { FakeVectorIndex, around, axis } from "./fake-vector-index.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSimilarity } from "./similarity.ts";
import { FakeStore, silentLogger } from "./test-fakes.ts";
import { knowledgeScope, visibleCollections } from "./visibility.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const members = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `ke_${prefix}${i}`);

async function labels(t: TestContext, options: { file?: unknown; describe?: (ids: readonly string[]) => ClusterDescription | null; limit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kg-cluster-labels-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "cluster-labels.json");
  if (options.file !== undefined) await writeFile(path, typeof options.file === "string" ? options.file : JSON.stringify(options.file));
  let refreshed = 0;
  const port = new KnowledgeClusterLabels({
    path,
    describe:
      options.describe ??
      ((ids) => ({ titles: ids.map((id) => `Title of ${id}`), concepts: [{ name: "Paywall", type: "Tactic" }], forbidden: ["Candy Crush", "@jasonugc"] })),
    refresh: async () => {
      refreshed += 1;
    },
    now: () => NOW,
    logger: silentLogger(),
    ...(options.limit !== undefined ? { limit: options.limit } : {})
  });
  await port.load();
  return { port, path, dir, refreshed: () => refreshed, read: async () => JSON.parse(await readFile(path, "utf8")) as { version: number; labels: { key: string; members: string[]; label: string }[] } };
}

test("answers: exactly {label}, 2–5 words, ≤ 40 characters, no quotes, never an author or a brand alone; bad JSON refused", () => {
  const forbidden = ["Candy Crush", "@jasonugc", "App Store Preflight"];
  assert.equal(validateClusterLabelAnswer({ label: "Paywall pricing" }, forbidden), null);
  assert.equal(validateClusterLabelAnswer({ label: "App Store review rules" }, forbidden), null);
  // An apostrophe is no quote.
  for (const label of ["Apple's review rules", "Founders' pricing", "App Store’s review", "Don't-miss growth tactics"]) {
    assert.equal(validateClusterLabelAnswer({ label }, forbidden), null, label);
  }
  for (const bad of [
    null,
    [],
    { label: 3 },
    { label: "" },
    { label: "ChatGPT" },
    { label: "One two three four five six" },
    { label: "A label that is far too long for a cluster name" },
    { label: '"Paywall pricing"' },
    { label: "'Paywall pricing'" },
    { label: "‘Paywall pricing’" },
    { label: "Candy  crush" },
    { label: "Candy Crush's" },
    { label: "@JasonUGC" },
    { label: "App Store Preflight" },
    { label: "Paywall pricing", extra: 1 }
  ]) {
    assert.equal(typeof validateClusterLabelAnswer(bad, forbidden), "string", JSON.stringify(bad));
  }
  assert.equal(parseClusterLabelAnswer('{"label": " User   retention "}'), "User retention");
  assert.equal(parseClusterLabelAnswer("{label: x}"), null);
  assert.equal(parseClusterLabelAnswer('{"label": "Candy Crush"}', forbidden), null);
});

test("the task shows the titles and shared concepts; the instructions ask for a topic, not a brand", () => {
  const input = clusterNameInput({ titles: ["Paywall A/B tests", "Annual vs weekly plans"], concepts: [{ name: "Paywall", type: "Tactic" }], forbidden: [] });
  assert.equal(input, "ENTRY TITLES (2)\n- Paywall A/B tests\n- Annual vs weekly plans\n\nSHARED CONCEPTS\n- Paywall (Tactic)\n\nName the topic these entries share. Answer with the JSON object only.");
  assert.match(CLUSTER_NAME_SYSTEM, /2 to 5 words/);
  assert.match(CLUSTER_NAME_SYSTEM, /Never only an author's name, a product, tool, app or brand name/);
  assert.match(CLUSTER_NAME_SYSTEM, /\{"label": "<topic name>"\}/);
});

test("clusters of 3+ are queued once, asked largest first up to the cap, named once; a label is reused while 80% of the members stay", async (t) => {
  const h = await labels(t, { limit: 2 });
  let work = 0;
  h.port.onWork(() => (work += 1));
  const big = members("a", 5);
  const mid = members("b", 4);
  const small = members("c", 3);
  h.port.request([small, big, mid, members("d", 2)]);
  assert.equal(work, 1);
  h.port.request([small, big, mid]);
  assert.equal(work, 1, "already queued: no new work");
  assert.equal(h.port.waiting().length, 3, "the pair is too small");
  const tasks = await h.port.tasks();
  assert.equal(h.refreshed(), 1, "the clusters are drawn before a round takes its tasks");
  assert.deepEqual(tasks.map((task) => task.label), [`${CLUSTER_NAME_STEP} ${clusterKey(big)}`, `${CLUSTER_NAME_STEP} ${clusterKey(mid)}`]);
  assert.match(tasks[0]!.user, /ENTRY TITLES \(5\)\n- Title of ke_a0/);
  assert.equal(tasks[0]!.system, CLUSTER_NAME_SYSTEM);
  // A cluster rounds gave up on naming is skipped; the next one takes its place under the cap, and it stays queued.
  const skipping = await h.port.tasks({ skip: (task) => task.label === tasks[0]!.label });
  assert.deepEqual(skipping.map((task) => task.label), [`${CLUSTER_NAME_STEP} ${clusterKey(mid)}`, `${CLUSTER_NAME_STEP} ${clusterKey(small)}`]);
  assert.equal(h.port.waiting().length, 3);
  assert.equal(h.port.validate({ label: "Candy Crush" }, tasks[0]!.payload) !== null, true, "the cluster's forbidden names");
  assert.equal(h.port.validate({ label: "Paywall pricing" }, tasks[0]!.payload), null);

  let changes = 0;
  h.port.onChange(() => (changes += 1));
  const before = h.port.revision();
  await h.port.record(tasks[0]!.payload, JSON.stringify({ label: "Paywall pricing" }));
  await h.port.record(tasks[1]!.payload, "not json");
  assert.equal(changes, 1);
  assert.ok(h.port.revision() > before);
  const none = () => false;
  assert.equal(h.port.labelFor(big, none), "Paywall pricing");
  assert.equal(h.port.labelFor([...big, "ke_new"], none), "Paywall pricing", "5 of 6: reused");
  assert.equal(h.port.labelFor([...big.slice(0, 4), "ke_new"], none), "Paywall pricing", "4 of 5 the same: reused");
  assert.equal(h.port.labelFor([...big.slice(0, 3), "ke_x", "ke_y"], none), null, "3 of 5: a new cluster");
  assert.equal(h.port.labelFor([...big, "ke_n1", "ke_n2"], none), null, "5 of 7: too different");
  assert.equal(h.port.labelFor(big, (id) => id === "ke_a2"), null, "named from an entry the caller cannot see");
  // Named: never asked again; the rest are.
  h.port.request([big, [...big, "ke_new"]]);
  const next = await h.port.tasks();
  assert.deepEqual(next.map((task) => task.label).sort(), [`${CLUSTER_NAME_STEP} ${clusterKey(mid)}`, `${CLUSTER_NAME_STEP} ${clusterKey(small)}`].sort());
  assert.ok(next.length <= CLUSTER_NAME_MAX_PER_ROUND);

  const file = await h.read();
  assert.deepEqual(file.labels.map((l) => [l.key, l.members, l.label]), [[clusterKey(big), [...big].sort(), "Paywall pricing"]]);
  const reloaded = await labels(t, { file });
  assert.equal(reloaded.port.labelFor(big, none), "Paywall pricing", "persisted");
});

test("a cluster that changed (mostly the same) replaces its queued version; one no entry of exists any more is dropped", async (t) => {
  const h = await labels(t, { describe: (ids) => (ids.includes("ke_gone0") ? null : { titles: ids.map((id) => id), concepts: [], forbidden: [] }) });
  h.port.request([members("a", 5)]);
  h.port.request([[...members("a", 5), "ke_a5"]]);
  h.port.request([members("gone", 4)]);
  assert.equal(h.port.waiting().length, 2);
  const tasks = await h.port.tasks();
  assert.deepEqual(tasks.map((task) => (task.payload as { members: string[] }).members.length), [6]);
  assert.equal(h.port.waiting().length, 1);
});

test("tolerant file: unreadable records and unknown keys survive; a newer file is never written; an unparsable one is moved aside", async (t) => {
  const record = { key: clusterKey(members("a", 3)), members: members("a", 3), label: "App Store review", labeledAt: "t", extra: 1 };
  const h = await labels(t, { file: { version: 1, labels: [record, { broken: true }], future: "x" } });
  assert.equal(h.port.labelFor(members("a", 3), () => false), "App Store review");
  h.port.request([members("b", 3)]);
  const [task] = await h.port.tasks();
  await h.port.record(task!.payload, JSON.stringify({ label: "Retention metrics" }));
  const written = (await h.read()) as unknown as { labels: Record<string, unknown>[]; future: string };
  assert.equal(written.future, "x");
  assert.deepEqual(written.labels[2], { broken: true }, "kept verbatim");
  assert.equal(written.labels[0]!.extra, 1);

  const newer = JSON.stringify({ version: 2, labels: [record] });
  const n = await labels(t, { file: newer });
  assert.equal(n.port.labelFor(members("a", 3), () => false), "App Store review", "read");
  assert.deepEqual(await n.port.tasks(), [], "nothing asked");
  assert.equal(await readFile(n.path, "utf8"), newer);

  const bad = await labels(t, { file: "{ nope" });
  assert.equal(bad.port.labelFor(members("a", 3), () => false), null);
  assert.ok((await readdir(bad.dir)).some((name) => name.startsWith("cluster-labels.json.unreadable-")));
});

// ---------------------------------------------------------------------------
// Similarity reads the injected labels
// ---------------------------------------------------------------------------

const DIMS = 16;
const ke = (name: string): string => `ke_${name.padStart(12, "0")}`;

test("similarity: a cluster takes the LLM label when there is one (scoped: only from entries the caller sees), else its concept label, and asks for it", async (t) => {
  const store = new FakeStore();
  store.collection("kc_seo", "SEO");
  store.collection("kc_ads", "Ads");
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const index = new FakeVectorIndex();
  const similarity = new KnowledgeSimilarity({
    store,
    graph,
    index: () => index,
    body: (id) => store.entries.get(id)?.body ?? null,
    summary: (meta, scope) => ({ ...meta, collections: visibleCollections(meta, scope), snippet: "", linkCount: 0, citation: knowledgeCitation(meta) })
  });
  const scope = (visibility: KnowledgeVisibility) => knowledgeScope(visibility, ["kc_seo", "kc_ads"]);
  const names = ["p1", "p2", "p3", "p4", "p5"];
  names.forEach((name, i) => {
    store.put(ke(name), `body ${name}`, [name === "p5" ? "kc_ads" : "kc_seo"], { title: `Comparison pages ${name}` }, true);
    index.set(ke(name), around(DIMS, 0, i + 1, 0.95));
  });
  store.put(ke("q1"), "q1", ["kc_seo"], { title: "Ads budget one" }, true);
  store.put(ke("q2"), "q2", ["kc_seo"], { title: "Ads budget two" }, true);
  index.set(ke("q1"), axis(DIMS, 10));
  index.set(ke("q2"), around(DIMS, 10, 11, 0.9));

  const before = await similarity.graph({}, scope({ kind: "all" }));
  const fallback = before.clusters[0]!.label;
  assert.ok(fallback && fallback !== "Comparison page strategy");

  const h = await labels(t);
  similarity.connectClusterLabels(h.port);
  const asked = await similarity.graph({}, scope({ kind: "all" }));
  assert.equal(asked.clusters[0]!.label, fallback, "no LLM label yet: the concept label");
  assert.deepEqual(h.port.waiting().map((m) => [...m].sort()), [names.map(ke).sort()], "the 5-entry cluster is asked for; the pair is not");
  const [task] = await h.port.tasks();
  await h.port.record(task!.payload, JSON.stringify({ label: "Comparison page strategy" }));

  const named = await similarity.graph({}, scope({ kind: "all" }));
  assert.equal(named.clusters[0]!.label, "Comparison page strategy");
  assert.equal(named.clusters.find((c) => c.size === 2)!.label, before.clusters.find((c) => c.size === 2)!.label);
  // A caller who cannot see p5 sees the concept label: the name came from p5 too.
  const seo = await similarity.graph({}, scope({ kind: "collections", ids: ["kc_seo"] }));
  assert.notEqual(seo.clusters[0]!.label, "Comparison page strategy");
  // Disconnected: back to the concept labels.
  similarity.connectClusterLabels(null);
  assert.equal((await similarity.graph({}, scope({ kind: "all" }))).clusters[0]!.label, fallback);
});
