import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Tokenizer } from "@huggingface/tokenizers";
import { EMBEDDING_MODEL } from "../install/pins.ts";
import { OnnxSentenceEmbedder } from "./embedder.ts";
import { chunkBody, embeddingHeader, embeddingPassage } from "./text.ts";

// Runs only with real model files: ORQUESTER_KG_MODEL_DIR is a transformers.js `localModelPath`
// holding the pinned model (`install/pins.ts`), i.e. Xenova/multilingual-e5-small/{config.json,
// tokenizer.json, tokenizer_config.json, special_tokens_map.json, onnx/model_quantized.onnx}
// (an installed runtime's `versions/<mykg>/models` is one).
const MODEL_DIR = process.env.ORQUESTER_KG_MODEL_DIR;
const MODEL_ID = EMBEDDING_MODEL.id;
const SKIP = MODEL_DIR ? false : `set ORQUESTER_KG_MODEL_DIR to a dir holding ${MODEL_ID} to run`;

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

function pinned(logger: Pick<Console, "warn"> = console): OnnxSentenceEmbedder {
  return new OnnxSentenceEmbedder({
    modelDir: MODEL_DIR!,
    modelId: MODEL_ID,
    dimensions: EMBEDDING_MODEL.dimensions,
    maxTokens: EMBEDDING_MODEL.maxTokens,
    queryPrefix: EMBEDDING_MODEL.queryPrefix,
    passagePrefix: EMBEDDING_MODEL.passagePrefix,
    thresholds: EMBEDDING_MODEL.thresholds,
    logger
  });
}

test("the pinned model on onnxruntime-node: 384-d normalized vectors, semantically ordered across languages, fast when warm", { skip: SKIP, timeout: 120_000 }, async (t) => {
  const embedder = pinned();
  t.after(() => embedder.dispose());
  const loadStarted = performance.now();
  await embedder.warm();
  const loadMs = performance.now() - loadStarted;

  const [query, queryEs] = await embedder.embed(["Ranking in ChatGPT", "Cómo aparecer en las respuestas de ChatGPT"], "query");
  const [close, far] = await embedder.embed([
    "How Cloudflare got cited by AI answer engines like Perplexity and Gemini",
    "Cap the daily budget while an ads campaign is in its learning phase"
  ]);
  assert.equal(query!.length, 384);
  assert.ok(Math.abs(dot(query!, query!) - 1) < 1e-4);
  assert.ok(dot(query!, close!) > dot(query!, far!), `close ${dot(query!, close!)} far ${dot(query!, far!)}`);
  assert.ok(dot(queryEs!, close!) > dot(queryEs!, far!), `es: close ${dot(queryEs!, close!)} far ${dot(queryEs!, far!)}`);

  const short = "Alternatives pages convert well. Write one per competitor: [competitor] vs [you], with honest comparison tables.";
  const timings: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now();
    await embedder.embed([short]);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const median = timings[10]!;
  const worst = timings[timings.length - 1]!;

  t.diagnostic(`model load ${loadMs.toFixed(0)} ms; short entry warm median ${median.toFixed(1)} ms, max ${worst.toFixed(1)} ms`);
  assert.ok(median < 200, `warm median ${median.toFixed(1)} ms`);
});

test("contextual passages fit the pinned tokenizer's 512-token limit, including prefix and special tokens", { skip: SKIP }, async () => {
  const [definition, config] = await Promise.all([
    readFile(join(MODEL_DIR!, MODEL_ID, "tokenizer.json"), "utf8"),
    readFile(join(MODEL_DIR!, MODEL_ID, "tokenizer_config.json"), "utf8")
  ]);
  const tokenizer = new Tokenizer(JSON.parse(definition), JSON.parse(config));
  const header = embeddingHeader({
    title: "A fairly long title about paywalls, TikTok ads and landing pages that convert in 2026",
    author: "María José Fernández",
    handle: "mariajose_growth",
    kind: "article"
  });
  const bodies = {
    minifiedJson: JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: `ke_${i.toString(36)}`, v: i * 1.234, ok: i % 3 === 0 }))),
    base64: Buffer.from(Array.from({ length: 4_000 }, (_, i) => (i * 2_654_435_761) % 256)).toString("base64"),
    hex: Array.from({ length: 60 }, (_, i) => (BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, "0").repeat(4)).join(" "),
    chinese: "付费墙测试显示年度订阅的转化率更高。我们在抖音上投放广告，并优化了落地页。用户留存是关键指标。".repeat(40),
    japanese: "ペイウォールのテストでは年間プランの転換率が高かった。TikTokで広告を出し、ランディングページを最適化した。".repeat(40),
    symbols: "∑∫∂√∞≈≠≤≥±×÷∆∇∈∉∩∪⊂⊃⊆⊇∧∨¬⇒⇔∀∃".repeat(60),
    emoji: "🚀🔥💯 Launch day! 🎉🎉🎉 👉 link in bio 🙏✨😂🤣❤️👍 ".repeat(60),
    code: Array.from({ length: 120 }, (_, i) => `const v${i} = items.filter((x) => x.id !== ${i}).map((x) => ({ ...x, rank: x.rank * 2 }));`).join("\n"),
    prose: "Las páginas de alternativas convierten bien. Write one per competitor, with honest comparison tables. ".repeat(80)
  };
  // A header at its cap: a 200-character CJK title and a 120-character author.
  const longHeader = embeddingHeader({
    title: "付费墙测试显示年度订阅的转化率更高我们在抖音上投放广告并优化了落地页".repeat(7).slice(0, 200),
    author: "María José Fernández de la Cruz y Montenegro, Growth Lead at Example Corporation International ".repeat(2).slice(0, 120),
    handle: "mariajose_growth",
    kind: "article"
  });
  for (const [label, head] of [["header", header], ["long header", longHeader]] as const) {
    for (const [name, body] of Object.entries(bodies)) {
      const passages = chunkBody(body).map((span) => embeddingPassage(head, body.slice(span.start, span.end)));
      for (const passage of passages) {
        const tokens = tokenizer.encode(`passage: ${passage}`, { add_special_tokens: true }).ids.length;
        assert.ok(tokens <= 512, `${label}, ${name}: ${tokens} tokens`);
      }
    }
  }
});
