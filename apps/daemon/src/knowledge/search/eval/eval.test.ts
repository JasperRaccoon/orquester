import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDING_MODEL } from "../../install/pins.ts";
import { OnnxSentenceEmbedder } from "../embedder.ts";
import { FakeEmbedder } from "../test-fakes.ts";
import { EVAL_ENTRIES, EVAL_QUERIES } from "./corpus.ts";
import { calibrationData, describeReport, describeSpread, evaluate, openEvalSearch } from "./harness.ts";

// The retrieval evaluation (retrieval spec P0.4). The real-model test runs only with the pinned
// model's files: ORQUESTER_KG_MODEL_DIR is a transformers.js `localModelPath` holding
// Xenova/multilingual-e5-small (as for embedder.model.test.ts; an installed runtime's
// `versions/<mykg>/models` is one). It also prints the calibration data the thresholds in
// install/pins.ts come from.

const MODEL_DIR = process.env.ORQUESTER_KG_MODEL_DIR;
const SKIP_MODEL = MODEL_DIR ? false : `set ORQUESTER_KG_MODEL_DIR to a dir holding ${EMBEDDING_MODEL.id} to run the evaluation with the real model`;

test("the evaluation set: ~30 entries and ~20 queries, English, Spanish and across, every expected id real", () => {
  const ids = new Set(EVAL_ENTRIES.map((entry) => entry.id));
  assert.equal(ids.size, EVAL_ENTRIES.length, "unique ids");
  assert.ok(EVAL_ENTRIES.length >= 28 && EVAL_ENTRIES.length <= 34);
  assert.ok(EVAL_QUERIES.length >= 18 && EVAL_QUERIES.length <= 26);
  for (const lang of ["en", "es"] as const) assert.ok(EVAL_ENTRIES.filter((entry) => entry.lang === lang).length >= 10, lang);
  for (const lang of ["en", "es", "en→es", "es→en"] as const) assert.ok(EVAL_QUERIES.some((query) => query.lang === lang), lang);
  for (const query of EVAL_QUERIES) {
    assert.ok(query.expected.length > 0, query.text);
    for (const id of query.expected) assert.ok(ids.has(id), `${query.text}: ${id}`);
    const langs = new Set(query.expected.map((id) => EVAL_ENTRIES.find((entry) => entry.id === id)!.lang));
    const target = query.lang.includes("→") ? query.lang.split("→")[1] : query.lang;
    assert.deepEqual([...langs], [target], `${query.text}: expected entries in ${target}`);
  }
  for (const entry of EVAL_ENTRIES) if (entry.duplicateOf) assert.ok(ids.has(entry.duplicateOf), entry.id);
  assert.equal(EVAL_ENTRIES.filter((entry) => entry.duplicateOf).length, 2);
});

test("recall@k and MRR count every expected entry in the top k and the first one's rank", async () => {
  const queries = [
    { text: "a", lang: "en", expected: ["x", "y"] },
    { text: "b", lang: "en", expected: ["z"] },
    { text: "c", lang: "en", expected: ["w"] }
  ] as const;
  const rankings: Record<string, string[]> = { a: ["q", "y", "r", "s", "t", "x"], b: ["z"], c: ["q", "r"] };
  const report = await evaluate(async (query) => rankings[query]!, queries, 5);
  assert.deepEqual(
    report.results.map((r) => [r.recall, r.reciprocalRank]),
    [
      [0.5, 0.5],
      [1, 1],
      [0, 0]
    ]
  );
  assert.equal(report.recallAtK, 0.5);
  assert.equal(report.mrr, 0.5);
  assert.equal(report.k, 5);
  assert.equal((await evaluate(async () => [], [], 5)).recallAtK, 0);
});

test("the harness runs the set through KnowledgeSearch (fake embedder): text and meaning both rank", async (t) => {
  const embedder = new FakeEmbedder({ dimensions: 64 });
  const evalSearch = await openEvalSearch(EVAL_ENTRIES, embedder);
  t.after(() => evalSearch.close());
  // Every entry was embedded before the harness returned.
  assert.ok(embedder.texts >= EVAL_ENTRIES.length);
  const report = await evaluate((query) => evalSearch.rank(query), EVAL_QUERIES, 5);
  assert.equal(report.results.length, EVAL_QUERIES.length);
  const ids = new Set(EVAL_ENTRIES.map((entry) => entry.id));
  for (const result of report.results) {
    assert.ok(result.ranked.length > 0 && result.ranked.length <= 10, result.query.text);
    for (const id of result.ranked) assert.ok(ids.has(id), id);
  }
  // Same-language queries share words with their answers: BM25 alone gets most of them.
  const sameLanguage = report.results.filter((r) => r.query.lang === "en" || r.query.lang === "es");
  assert.ok(sameLanguage.filter((r) => r.recall > 0).length >= sameLanguage.length * 0.6, describeReport(report).join("\n"));
  assert.ok(report.mrr > 0 && report.mrr <= 1);
  t.diagnostic(`fake embedder: recall@5 ${report.recallAtK.toFixed(3)}, MRR ${report.mrr.toFixed(3)}`);

  // Calibration data comes out of the same embedder with the shapes thresholds are chosen from.
  const calibration = await calibrationData(embedder, EVAL_ENTRIES, EVAL_QUERIES);
  assert.equal(calibration.matched.n, EVAL_QUERIES.reduce((sum, query) => sum + query.expected.length, 0));
  assert.equal(calibration.matched.n + calibration.unmatched.n, EVAL_QUERIES.length * EVAL_ENTRIES.length);
  assert.equal(calibration.hardestUnmatched.n, EVAL_QUERIES.length);
  assert.equal(calibration.duplicates.n, 2);
  assert.equal(calibration.duplicates.n + calibration.sameTopic.n + calibration.otherTopic.n, (EVAL_ENTRIES.length * (EVAL_ENTRIES.length - 1)) / 2);
  assert.ok(embedder.kinds.includes("query") && embedder.kinds.includes("passage"));
});

test("the pinned model: recall@5 ≥ 0.8 on the evaluation set, and thresholds that fit its calibration", { skip: SKIP_MODEL, timeout: 600_000 }, async (t) => {
  const embedder = new OnnxSentenceEmbedder({
    modelDir: MODEL_DIR!,
    modelId: EMBEDDING_MODEL.id,
    dimensions: EMBEDDING_MODEL.dimensions,
    maxTokens: EMBEDDING_MODEL.maxTokens,
    queryPrefix: EMBEDDING_MODEL.queryPrefix,
    passagePrefix: EMBEDDING_MODEL.passagePrefix,
    thresholds: EMBEDDING_MODEL.thresholds
  });
  t.after(() => embedder.dispose());
  const evalSearch = await openEvalSearch(EVAL_ENTRIES, embedder);
  t.after(() => evalSearch.close());
  const report = await evaluate((query) => evalSearch.rank(query), EVAL_QUERIES, 5);
  for (const line of describeReport(report)) t.diagnostic(line);
  t.diagnostic(`${EMBEDDING_MODEL.id}: recall@5 ${report.recallAtK.toFixed(3)}, MRR ${report.mrr.toFixed(3)}`);
  assert.ok(report.recallAtK >= 0.8, `recall@5 ${report.recallAtK.toFixed(3)}`);

  const calibration = await calibrationData(embedder, EVAL_ENTRIES, EVAL_QUERIES);
  for (const [name, s] of Object.entries(calibration)) t.diagnostic(describeSpread(name, s));
  const { minimum, good, strong, duplicate } = EMBEDDING_MODEL.thresholds;
  t.diagnostic(`thresholds: minimum ${minimum} good ${good} strong ${strong} duplicate ${duplicate}`);
  // Every answer clears `minimum`; most of them `good`; few non-answers reach `good`, `strong` is
  // above nearly every non-answer; `duplicate` sits between related entries and near-copies.
  assert.ok(calibration.matched.min >= minimum, "an answer falls under minimum");
  assert.ok(calibration.matched.p50 >= good, "most answers are at least good");
  assert.ok(calibration.unmatched.p90 < good, "too many non-answers are good");
  assert.ok(calibration.unmatched.max < strong + 0.02, "a non-answer is far into strong");
  assert.ok(calibration.duplicates.min >= duplicate, "a near-copy is not a duplicate");
  assert.ok(Math.max(calibration.sameTopic.max, calibration.otherTopic.max) < duplicate, "related entries count as duplicates");
});
