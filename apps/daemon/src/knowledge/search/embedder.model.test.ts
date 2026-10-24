import assert from "node:assert/strict";
import test from "node:test";
import { OnnxSentenceEmbedder, runtimeEmbedderSource } from "./embedder.ts";
import { chunkBody } from "./text.ts";

// Runs only with real model files: ORQUESTER_KG_MODEL_DIR is a transformers.js `localModelPath`
// holding Xenova/all-MiniLM-L6-v2/{config.json, tokenizer.json, tokenizer_config.json,
// special_tokens_map.json, onnx/model_quantized.onnx}.
const MODEL_DIR = process.env.ORQUESTER_KG_MODEL_DIR;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

test("all-MiniLM-L6-v2 on onnxruntime-node: 384-d normalized vectors, semantically ordered, fast when warm", { skip: !MODEL_DIR, timeout: 60_000 }, async (t) => {
  const embedder = new OnnxSentenceEmbedder({ modelDir: MODEL_DIR!, modelId: MODEL_ID, dimensions: 384 });
  t.after(() => embedder.dispose());
  const loadStarted = performance.now();
  await embedder.warm();
  const loadMs = performance.now() - loadStarted;

  const [query, close, far] = await embedder.embed([
    "Ranking in ChatGPT",
    "How Cloudflare got cited by AI answer engines like Perplexity and Gemini",
    "Cap the daily budget while an ads campaign is in its learning phase"
  ]);
  assert.equal(query!.length, 384);
  assert.ok(Math.abs(dot(query!, query!) - 1) < 1e-4);
  assert.ok(dot(query!, close!) > dot(query!, far!), `close ${dot(query!, close!)} far ${dot(query!, far!)}`);

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

  const long = Array.from({ length: 900 }, (_, i) => `word${i % 97} topic${i % 13}`).join(" ");
  const chunks = chunkBody(long).map((span) => long.slice(span.start, span.end));
  const longStarted = performance.now();
  const vectors = await embedder.embed(chunks);
  const longMs = performance.now() - longStarted;
  assert.equal(vectors.length, chunks.length);

  t.diagnostic(
    `model load ${loadMs.toFixed(0)} ms; short entry warm median ${median.toFixed(1)} ms, max ${worst.toFixed(1)} ms; ` +
      `${chunks.length} long chunks ${longMs.toFixed(0)} ms`
  );
  assert.ok(median < 200, `warm median ${median.toFixed(1)} ms`);
});

test("the runtime source makes the embedder lazily and swaps it when the runtime changes", { skip: !MODEL_DIR }, async () => {
  let runtime: { embeddingModelDir: string; embeddingModelId: string; embeddingDimensions: number } | null = null;
  const listeners = new Set<() => void>();
  const source = runtimeEmbedderSource({
    current: () =>
      runtime && { mykgVersion: "0.4.10", mykgBin: "/x", pythonBin: "/x", tiktokenCacheDir: "/x", ...runtime },
    onChange: (listener) => {
      listeners.add(listener as () => void);
      return () => listeners.delete(listener as () => void);
    }
  });
  assert.equal(source.current(), null);
  runtime = { embeddingModelDir: MODEL_DIR!, embeddingModelId: MODEL_ID, embeddingDimensions: 384 };
  const first = source.current()!;
  assert.equal(source.current(), first);
  assert.equal((await first.embed(["hello"]))[0]!.length, 384);
  runtime = { embeddingModelDir: "/nonexistent", embeddingModelId: MODEL_ID, embeddingDimensions: 384 };
  const second = source.current()!;
  assert.notEqual(second, first);
  await assert.rejects(second.embed(["hello"]));
  await source.dispose();
});
