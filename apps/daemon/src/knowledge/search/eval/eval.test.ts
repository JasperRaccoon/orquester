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

test("the evaluation harness retrieves known English and Spanish answers from the indexed corpus", async (t) => {
  const evalSearch = await openEvalSearch(EVAL_ENTRIES, new FakeEmbedder({ dimensions: 64 }));
  t.after(() => evalSearch.close());
  for (const [query, expected] of [
    ["which app store screenshots convert best", "ke_app_aso_screenshots"],
    ["cuántos días debe durar la prueba gratis", "ke_paywall_trial"]
  ]) {
    const ranked = await evalSearch.rank(query!);
    assert.ok(ranked.slice(0, 5).includes(expected!), `${query}: ${ranked}`);
  }
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
