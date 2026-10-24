import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Ort from "onnxruntime-node";
import type { KnowledgeRuntimePort } from "../ports.ts";

/**
 * Sentence embeddings, local and on CPU. Vectors are L2-normalized, so a dot product is the
 * cosine similarity. Tests inject a fake.
 */
export interface KnowledgeEmbedder {
  /** Cache key: vectors from another model are never mixed in. */
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** The embedder to use right now (null while the runtime is not installed). */
export interface KnowledgeEmbedderSource {
  current(): KnowledgeEmbedder | null;
  onChange(listener: () => void): () => void;
}

export interface OnnxEmbedderOptions {
  /** transformers.js-style `localModelPath`: the model lives in `<modelDir>/<modelId>/`. */
  modelDir: string;
  /** e.g. "Xenova/all-MiniLM-L6-v2". */
  modelId: string;
  dimensions: number;
  /** Tokens per input, special tokens included (all-MiniLM-L6-v2 was trained on 256). */
  maxTokens?: number;
  /** ONNX intra-op threads; small so search never starves the daemon. */
  threads?: number;
  batchSize?: number;
}

interface TokenizerLike {
  encode(text: string): { ids: number[] };
}

interface Loaded {
  ort: typeof Ort;
  session: Ort.InferenceSession;
  tokenizer: TokenizerLike;
  clsId: number;
  sepId: number;
  padId: number;
}

/**
 * A BERT-style sentence-transformer (all-MiniLM-L6-v2) on `onnxruntime-node` with the pure-JS
 * `@huggingface/tokenizers`: mean pooling over the attention mask, then L2 normalization — the
 * model's sentence-transformers recipe. Nothing is loaded until the first `embed`; a failed load
 * is remembered (every later call rejects at once) until a new instance is made.
 */
export class OnnxSentenceEmbedder implements KnowledgeEmbedder {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly modelDir: string;
  private readonly maxTokens: number;
  private readonly threads: number;
  private readonly batchSize: number;
  private loading: Promise<Loaded> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: OnnxEmbedderOptions) {
    this.modelDir = join(options.modelDir, options.modelId);
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.maxTokens = Math.max(8, options.maxTokens ?? 256);
    this.threads = Math.max(1, options.threads ?? 2);
    this.batchSize = Math.max(1, options.batchSize ?? 16);
  }

  /** Load the model now (optional; `embed` loads on demand). */
  warm(): Promise<void> {
    return this.load().then(() => undefined);
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    // One inference at a time per model: bounded CPU, predictable latency.
    const run = this.queue.then(() => this.embedNow(texts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const loading = this.loading;
    this.loading = null;
    if (!loading) return;
    const loaded = await loading.catch(() => null);
    await loaded?.session.release().catch(() => undefined);
  }

  private load(): Promise<Loaded> {
    if (this.disposed) return Promise.reject(new Error("the embedder was disposed"));
    this.loading ??= (async () => {
      const ortModule = (await import("onnxruntime-node")) as typeof Ort & { default?: typeof Ort };
      const ort = (ortModule.InferenceSession ? ortModule : ortModule.default) as typeof Ort;
      const tokenizers = (await import("@huggingface/tokenizers")) as typeof import("@huggingface/tokenizers");
      const [tokenizerJson, tokenizerConfig] = await Promise.all([
        readFile(join(this.modelDir, "tokenizer.json"), "utf8"),
        readFile(join(this.modelDir, "tokenizer_config.json"), "utf8")
      ]);
      const tokenizer = new tokenizers.Tokenizer(JSON.parse(tokenizerJson), JSON.parse(tokenizerConfig));
      const id = (token: string, fallback: number): number => tokenizer.token_to_id(token) ?? fallback;
      const session = await ort.InferenceSession.create(join(this.modelDir, "onnx", "model_quantized.onnx"), {
        executionProviders: ["cpu"],
        intraOpNumThreads: this.threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all"
      });
      return { ort, session, tokenizer, clsId: id("[CLS]", 101), sepId: id("[SEP]", 102), padId: id("[PAD]", 0) };
    })();
    return this.loading;
  }

  private async embedNow(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const loaded = await this.load();
    const encoded = texts.map((text) => this.encode(loaded, text));
    // Batch similar lengths together so padding stays small.
    const order = encoded.map((ids, index) => ({ ids, index })).sort((a, b) => a.ids.length - b.ids.length);
    const out = new Array<Float32Array>(texts.length);
    for (let start = 0; start < order.length; start += this.batchSize) {
      const batch = order.slice(start, start + this.batchSize);
      const vectors = await this.runBatch(loaded, batch.map((b) => b.ids));
      batch.forEach((item, i) => (out[item.index] = vectors[i]!));
    }
    return out;
  }

  private encode(loaded: Loaded, text: string): number[] {
    const ids = loaded.tokenizer.encode(text.length > 0 ? text : " ").ids;
    if (ids.length <= this.maxTokens) return ids;
    // Keep [CLS] … and close with [SEP], as the tokenizer's own truncation would.
    return [...ids.slice(0, this.maxTokens - 1), loaded.sepId];
  }

  private async runBatch(loaded: Loaded, batch: number[][]): Promise<Float32Array[]> {
    const { ort, session } = loaded;
    const rows = batch.length;
    const width = Math.max(...batch.map((ids) => ids.length));
    const inputIds = new BigInt64Array(rows * width).fill(BigInt(loaded.padId));
    const mask = new BigInt64Array(rows * width);
    batch.forEach((ids, row) => {
      for (let i = 0; i < ids.length; i += 1) {
        inputIds[row * width + i] = BigInt(ids[i]!);
        mask[row * width + i] = 1n;
      }
    });
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: new ort.Tensor("int64", inputIds, [rows, width]),
      attention_mask: new ort.Tensor("int64", mask, [rows, width])
    };
    if (session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(rows * width), [rows, width]);
    }
    const result = await session.run(feeds);
    const output = result.last_hidden_state ?? result[session.outputNames[0]!]!;
    const hidden = output.data as Float32Array;
    const dims = output.dims[2] ?? this.dimensions;
    const vectors: Float32Array[] = [];
    for (let row = 0; row < rows; row += 1) {
      const vector = new Float32Array(dims);
      const length = batch[row]!.length;
      for (let t = 0; t < length; t += 1) {
        const offset = (row * width + t) * dims;
        for (let d = 0; d < dims; d += 1) vector[d]! += hidden[offset + d]!;
      }
      let norm = 0;
      for (let d = 0; d < dims; d += 1) {
        vector[d]! /= length;
        norm += vector[d]! * vector[d]!;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dims; d += 1) vector[d]! /= norm;
      vectors.push(vector);
    }
    return vectors;
  }
}

/**
 * The embedder for the installed runtime (`KnowledgeRuntime.embeddingModelDir/Id/Dimensions`),
 * made lazily and replaced (the old one released) when the runtime changes. Null while none is
 * installed — search then runs on BM25 alone.
 */
export function runtimeEmbedderSource(
  runtime: KnowledgeRuntimePort,
  options: Pick<OnnxEmbedderOptions, "threads" | "batchSize" | "maxTokens"> = {}
): KnowledgeEmbedderSource & { dispose(): Promise<void> } {
  let key: string | null = null;
  let embedder: OnnxSentenceEmbedder | null = null;
  const listeners = new Set<() => void>();
  const unsubscribe = runtime.onChange(() => {
    for (const listener of listeners) listener();
  });
  return {
    current() {
      const rt = runtime.current();
      const next = rt ? `${rt.embeddingModelDir}\u0000${rt.embeddingModelId}\u0000${rt.embeddingDimensions}` : null;
      if (next !== key) {
        void embedder?.dispose();
        embedder =
          rt && next
            ? new OnnxSentenceEmbedder({
                modelDir: rt.embeddingModelDir,
                modelId: rt.embeddingModelId,
                dimensions: rt.embeddingDimensions,
                ...options
              })
            : null;
        key = next;
      }
      return embedder;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      unsubscribe();
      listeners.clear();
      await embedder?.dispose();
      embedder = null;
      key = null;
    }
  };
}
