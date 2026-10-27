/**
 * Measure the current retrieval backend with a cached 5,000-entry corpus, including long
 * entries, and entry pagination with a separate metadata corpus.
 * From apps/daemon:
 * TSX_DISABLE_CACHE=1 node --import tsx src/knowledge/search/search.bench.ts [search-module]
 *
 * The optional module path lets another revision use the same fixture. Setup (including the
 * deterministic fake model) is outside the measured region. Result digests must match between
 * revisions; timings include the real search, visibility, ranking and snippets.
 * With a module argument, pagination compares it with the current implementation in one
 * process, sharing the immutable fixture and alternating the order of timed calls.
 * Older measurements made before the retrieval redesign do not describe this backend.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KnowledgeVisibility } from "@orquester/api";
import { KnowledgeGraph } from "./graph.ts";
import type { KnowledgeSearch as Search } from "./search.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, silentLogger } from "./test-fakes.ts";

const { KnowledgeSearch } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "./search.ts") as {
  KnowledgeSearch: typeof Search;
};
const entries = 5_000;
const dimensions = 384;
const wordsPerEntry = 900;
const samples = 35;
let seed = 42;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const id = (prefix: string, n: number, width: number) => `${prefix}${n.toString(32).padStart(width, "0")}`;
const store = new FakeStore();
const collections = Array.from({ length: 8 }, (_, i) => store.collection(id("kc_", i, 10), `Collection ${i}`).id);
const vocabulary = Array.from({ length: 2_000 }, (_, i) => `term${i.toString(36)}`);
for (let i = 0; i < entries; i += 1) {
  const words = Array.from({ length: wordsPerEntry }, () => vocabulary[Math.floor(random() * vocabulary.length)]!);
  store.put(id("ke_", i, 12), words.join(" "), [collections[i % collections.length]!], { title: words.slice(0, 6).join(" ") }, true);
}
// Match KnowledgeStore's O(1), allocation-free metadata lookup; FakeStore normally copies it.
const metadata = new Map(store.listMeta().map((meta) => [meta.id, meta]));
store.getMeta = (entryId) => metadata.get(entryId) ?? null;
const indexDir = await mkdtemp(join(tmpdir(), "orquester-knowledge-bench-"));
const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(new FakeEmbedder({ dimensions })), indexDir, logger: silentLogger() });
try {
  await search.start();
  await search.search({ query: "term1 term2" }, { kind: "all" });
  await search.idle();
  const scopes: { name: string; visibility: KnowledgeVisibility; collections?: string[] }[] = [
    { name: "all", visibility: { kind: "all" } },
    { name: "one-of-eight-profile", visibility: { kind: "collections", ids: [collections[0]!] } },
    { name: "one-of-eight-filter", visibility: { kind: "all" }, collections: [collections[0]!] },
    { name: "no-visible-collections", visibility: { kind: "collections", ids: [] } }
  ];
  for (const scope of scopes) {
    const wall: number[] = [];
    const cpu: number[] = [];
    const digest = createHash("sha256");
    for (let run = 0; run < samples + 5; run += 1) {
      const query = `${vocabulary[run % 7]} ${vocabulary[100 + (run % 11)]}`;
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const result = await search.search({ query, collections: scope.collections, limit: 8 }, scope.visibility);
      const elapsed = performance.now() - start;
      const usage = process.cpuUsage(cpuStart);
      assert.equal(result.searched.length, scope.name === "all" ? 8 : scope.name === "no-visible-collections" ? 0 : 1);
      if (run >= 5) {
        wall.push(elapsed);
        cpu.push((usage.user + usage.system) / 1000);
        digest.update(JSON.stringify(result));
      }
    }
    console.log(JSON.stringify({ scope: scope.name, entries, dimensions, wordsPerEntry, samples, wallMedianMs: median(wall), cpuMedianMs: median(cpu), resultDigest: digest.digest("hex") }));
  }
  // Saved timestamps are deliberately shuffled: import order need not be chronological.
  const listStore = new FakeStore();
  listStore.collection(collections[0]!, "Collection 0");
  listStore.collection(collections[1]!, "Collection 1");
  const listEntries = 30_000;
  for (let i = 0; i < listEntries; i += 1) {
    listStore.put(id("ke_", i, 12), "Saved note.", [collections[i % 2]!], {
      title: `Note ${i}`,
      savedAt: new Date(Date.parse("2026-01-01") + Math.floor(random() * 30_000) * 1_000).toISOString()
    }, true);
  }
  const listMetas = Object.freeze(listStore.listMeta());
  const listMetadata = new Map(listMetas.map((meta) => [meta.id, meta]));
  // The real store reuses its immutable metadata array until a write invalidates it.
  listStore.listMeta = () => listMetas;
  listStore.getMeta = (entryId) => listMetadata.get(entryId) ?? null;
  const paginationModules = [{ name: process.argv[2] ? "baseline" : "current", Search: KnowledgeSearch }];
  if (process.argv[2]) paginationModules.push({ name: "current", Search: (await import("./search.ts")).KnowledgeSearch });
  const listSearches = paginationModules.map(({ name, Search }) => ({
    name,
    search: new Search({
      store: listStore,
      graph: new KnowledgeGraph({ entries: listStore, logger: silentLogger() }),
      embedders: new FakeEmbedderSource(null),
      indexDir,
      logger: silentLogger()
    })
  }));
  try {
    for (const { search } of listSearches) await search.start();
    const sorted = [...listMetadata.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const name of ["first-page", "near-end-page"] as const) {
      const previous = name === "near-end-page" ? sorted[sorted.length - 101]! : null;
      const cursor = previous ? Buffer.from(JSON.stringify([previous.savedAt, previous.id]), "utf8").toString("base64url") : undefined;
      const expected = sorted.slice(previous ? sorted.length - 100 : 0, previous ? sorted.length - 50 : 50).map((meta) => meta.id);
      const measurements = new Map(listSearches.map(({ name }) => [name, { wall: [] as number[], digest: createHash("sha256") }]));
      for (let run = 0; run < samples + 5; run += 1) {
        for (const { name, search } of run % 2 === 0 ? listSearches : [...listSearches].reverse()) {
          const start = performance.now();
          const result = await search.listEntries({ cursor, limit: 50 }, { kind: "all" });
          const elapsed = performance.now() - start;
          assert.deepEqual(result.entries.map((entry) => entry.id), expected);
          if (run >= 5) {
            const measurement = measurements.get(name)!;
            measurement.wall.push(elapsed);
            measurement.digest.update(JSON.stringify(result));
          }
        }
      }
      let firstDigest: string | undefined;
      for (const [implementation, { wall, digest }] of measurements) {
        const resultDigest = digest.digest("hex");
        if (firstDigest) assert.equal(resultDigest, firstDigest, "pagination responses and cursors differ between implementations");
        else firstDigest = resultDigest;
        console.log(JSON.stringify({ pagination: name, implementation, entries: listEntries, samples, wallMedianMs: median(wall), resultDigest }));
      }
    }
  } finally {
    for (const { search } of listSearches) await search.stop();
  }
} finally {
  await search.stop();
  await rm(indexDir, { recursive: true, force: true });
}
