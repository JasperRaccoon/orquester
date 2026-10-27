import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDING_MODEL } from "../install/pins.ts";
import { E5_SMALL_CONCEPT_THRESHOLDS, conceptMergeRefusal, conceptThresholdsFor, planConceptMerges } from "./concept-merges.ts";
import { conceptEmbeddingText } from "./concept-vectors.ts";
import { OnnxSentenceEmbedder } from "./embedder.ts";

// The concept-merge calibration on the pinned model (see `E5_SMALL_CONCEPT_THRESHOLDS`), on concept
// names from the live graph of 2026-10-27. Runs only with ORQUESTER_KG_MODEL_DIR (as in
// embedder.model.test.ts).
const MODEL_DIR = process.env.ORQUESTER_KG_MODEL_DIR;
const SKIP = MODEL_DIR ? false : `set ORQUESTER_KG_MODEL_DIR to a dir holding ${EMBEDDING_MODEL.id} to run`;

/** Same thing, two names: merged. */
const SAME: [type: string, a: string, b: string][] = [
  ["Tactic", "Warm up TikTok account", "Warm up the TikTok account"],
  ["Tactic", "Set language and region to target country", "Set language and region to the target country"],
  ["Tactic", "Below the fold social proof", "Below-the-fold social proof"],
  ["Tactic", "Transparent upstream proxy on the router", "Upstream proxy on router"],
  ["Tactic", "Submit an MCP server to ChatGPT as a plugin", "Submit your MCP server as a plugin in ChatGPT"],
  ["Tactic", "Card-required trial", "Card-required trials"],
  ["Tactic", "Location services off", "Keep location services off"],
  ["Metric", "App Store rating", "Public App Store rating"]
];

/** Close in meaning (≥ the merge bar) but different things: refused, and why. */
const DIFFERENT: [type: string, a: string, b: string, why: string][] = [
  ["Guideline", "Guideline 2.4.5(vii)", "Guideline 2.4.5(viii)", "numbers"],
  ["Guideline", "Guideline 4.7.4", "Guideline 4.7.5", "numbers"],
  ["Result", "Opt-in visitor-to-trial", "Opt-out visitor-to-trial", "lexical"],
  ["Result", "Vercel citations on Gemini", "Replit citations on Gemini", "lexical"],
  ["Channel", "App Store", "Mac App Store", "lexical"],
  ["Regulation", "Utah age assurance / parental consent law", "Louisiana age assurance / parental consent law", "lexical"],
  ["Tactic", "Fear words in headlines", "Sadness words in headlines", "lexical"],
  ["Tactic", "App Store submission checklist", "App Store submission checklist to avoid rejections", "negation"],
  ["Tactic", "US TikTok account via free Visible eSIM", "US TikTok account via free Visible eSIM + location spoofing", "list"],
  ["Person", "KCodes7777", "person-personkcodes7777", "person"]
];

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

test("concept merge calibration on the pinned model: duplicates merge, look-alikes do not", { skip: SKIP, timeout: 120_000 }, async () => {
  assert.deepEqual(conceptThresholdsFor(EMBEDDING_MODEL.id), E5_SMALL_CONCEPT_THRESHOLDS);
  const embedder = new OnnxSentenceEmbedder({
    modelDir: MODEL_DIR!,
    modelId: EMBEDDING_MODEL.id,
    dimensions: EMBEDDING_MODEL.dimensions,
    maxTokens: EMBEDDING_MODEL.maxTokens,
    queryPrefix: EMBEDDING_MODEL.queryPrefix,
    passagePrefix: EMBEDDING_MODEL.passagePrefix,
    thresholds: EMBEDDING_MODEL.thresholds
  });
  try {
    const concepts: { id: string; type: string; name: string; entryCount: number }[] = [];
    const add = (type: string, name: string): string => {
      const id = `${type.toLowerCase()}-${concepts.length}`;
      concepts.push({ id, type, name, entryCount: 1 });
      return id;
    };
    const same = SAME.map(([type, a, b]) => [add(type, a), add(type, b)] as const);
    const different = DIFFERENT.map(([type, a, b]) => [add(type, a), add(type, b)] as const);
    const texts = concepts.map((c) => conceptEmbeddingText({ id: c.id, type: c.type, name: c.name, aliases: [], description: null }));
    const out = await embedder.embed(texts, "passage");
    const vectors = new Map(concepts.map((c, i) => [c.id, out[i]!]));
    const byId = new Map(concepts.map((c) => [c.id, c]));
    const bars = E5_SMALL_CONCEPT_THRESHOLDS;

    for (const [a, b] of same) {
      const similarity = dot(vectors.get(a)!, vectors.get(b)!);
      assert.equal(conceptMergeRefusal(byId.get(a)!, byId.get(b)!, similarity, bars), null, `${byId.get(a)!.name} ~ ${byId.get(b)!.name} (${similarity.toFixed(3)})`);
    }
    DIFFERENT.forEach(([, , , why], i) => {
      const [a, b] = different[i]!;
      const similarity = dot(vectors.get(a)!, vectors.get(b)!);
      assert.ok(similarity >= bars.merge, `a near miss: ${byId.get(a)!.name} ~ ${byId.get(b)!.name} ${similarity.toFixed(3)}`);
      assert.equal(conceptMergeRefusal(byId.get(a)!, byId.get(b)!, similarity, bars), why, `${byId.get(a)!.name} ~ ${byId.get(b)!.name}`);
    });

    const { merges } = await planConceptMerges({ concepts, vectors, thresholds: bars, existing: [], rejected: [], now: "now", pause: async () => undefined });
    const groups = merges.map((m) => [m.into, ...m.merged].sort().join(" + ")).sort();
    assert.deepEqual(groups, same.map(([a, b]) => [a, b].sort().join(" + ")).sort());
  } finally {
    await embedder.dispose();
  }
});
