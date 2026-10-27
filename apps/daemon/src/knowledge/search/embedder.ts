import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Ort from "onnxruntime-node";
import type { KnowledgeRuntimePort, KnowledgeVectorThresholds } from "../ports.ts";

/**
 * What a text is embedded as. Asymmetric models (the e5 family) prefix them differently
 * ("query: " / "passage: "); symmetric ones ignore it.
 */
export type KnowledgeEmbedKind = "query" | "passage";

/**
 * Sentence embeddings, local and on CPU. Vectors are L2-normalized, so a dot product is the
 * cosine similarity. Tests inject a fake.
 */
export interface KnowledgeEmbedder {
  /** Cache key: vectors from another model are never mixed in. */
  readonly modelId: string;
  readonly dimensions: number;
  readonly thresholds: KnowledgeVectorThresholds;
  /** `kind` defaults to "passage". */
  embed(texts: readonly string[], kind?: KnowledgeEmbedKind): Promise<Float32Array[]>;
}

/** all-MiniLM-L6-v2's cut-offs (the model shipped before the retrieval spec). */
export const MINILM_THRESHOLDS: KnowledgeVectorThresholds = { minimum: 0.25, good: 0.4, strong: 0.55, duplicate: 0.92 };

/** The embedder to use right now (null while the runtime is not installed). */
export interface KnowledgeEmbedderSource {
  current(): KnowledgeEmbedder | null;
  onChange(listener: () => void): () => void;
}

export interface OnnxEmbedderOptions {
  /** transformers.js-style `localModelPath`: the model lives in `<modelDir>/<modelId>/`. */
  modelDir: string;
  /** e.g. "Xenova/multilingual-e5-small". */
  modelId: string;
  dimensions: number;
  /** Tokens per input, special tokens included (256 by default; multilingual-e5-small: 512). */
  maxTokens?: number;
  /** Put before every query / passage text (`embed`'s `kind`); none by default (a symmetric model). */
  queryPrefix?: string;
  passagePrefix?: string;
  /** The model's cut-offs (all-MiniLM-L6-v2's by default). */
  thresholds?: KnowledgeVectorThresholds;
  /** ONNX intra-op threads; small so search never starves the daemon. */
  threads?: number;
  batchSize?: number;
  /** Where the truncation count goes (one line per `embed` call that truncated anything). */
  logger?: Pick<Console, "warn">;
}

/** The part of `@huggingface/tokenizers`' Tokenizer the embedder uses. */
interface EmbedderTokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] };
  token_to_id(token: string): number | undefined;
}

/**
 * How the model's tokenizer frames one sequence, read from the tokenizer itself (never BERT's
 * ids): the special tokens its post-processor puts before and after the text (XLM-R: `<s>` …
 * `</s>`; BERT: `[CLS]` … `[SEP]`), and its padding token.
 */
interface TokenFrame {
  before: readonly number[];
  after: readonly number[];
  pad: number;
}

/**
 * The tokenizer's {@link TokenFrame}: a probe word encoded with and without special tokens shows
 * what the post-processor adds on each side; the padding token is `tokenizer_config.json`'s
 * `pad_token` (else the end token: padding is masked out anyway).
 */
function tokenFrameOf(tokenizer: EmbedderTokenizer, config: unknown): TokenFrame {
  const framed = tokenizer.encode("a").ids;
  const bare = tokenizer.encode("a", { add_special_tokens: false }).ids;
  let at = -1;
  for (let i = 0; bare.length > 0 && i + bare.length <= framed.length; i += 1) {
    if (bare.every((id, k) => framed[i + k] === id)) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("the tokenizer's special tokens could not be told apart from the text");
  const before = framed.slice(0, at);
  const after = framed.slice(at + bare.length);
  const padName = tokenName((config as { pad_token?: unknown } | null)?.pad_token);
  const pad = (padName !== null ? tokenizer.token_to_id(padName) : undefined) ?? after.at(-1) ?? before[0] ?? 0;
  return { before, after, pad };
}

/** A `tokenizer_config.json` token: a plain string or an `AddedToken` object's `content`. */
function tokenName(value: unknown): string | null {
  if (typeof value === "string") return value;
  const content = (value as { content?: unknown } | null)?.content;
  return typeof content === "string" ? content : null;
}

/**
 * `bare` (text ids without special tokens) framed for the model in at most `maxTokens` ids: cut
 * to fit, still closed with the model's own end token(s), as the tokenizer's own truncation would.
 */
function frameIds(frame: TokenFrame, bare: readonly number[], maxTokens: number): { ids: number[]; truncated: boolean } {
  const room = Math.max(0, maxTokens - frame.before.length - frame.after.length);
  const truncated = bare.length > room;
  return { ids: [...frame.before, ...(truncated ? bare.slice(0, room) : bare), ...frame.after], truncated };
}

/**
 * Mean pooling over the attention mask, then L2 normalization (the sentence-transformers and e5
 * recipe): `hidden` is the last hidden state, rows × width × dims; row `r` has `lengths[r]` real
 * tokens (the rest is padding).
 */
function meanPoolNormalized(hidden: Float32Array, lengths: readonly number[], width: number, dims: number): Float32Array[] {
  return lengths.map((length, row) => {
    const vector = new Float32Array(dims);
    for (let t = 0; t < length; t += 1) {
      const offset = (row * width + t) * dims;
      for (let d = 0; d < dims; d += 1) vector[d]! += hidden[offset + d]!;
    }
    let norm = 0;
    for (let d = 0; d < dims; d += 1) {
      vector[d]! /= Math.max(1, length);
      norm += vector[d]! * vector[d]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d += 1) vector[d]! /= norm;
    return vector;
  });
}

/** One forward pass of the model: ids and attention mask (rows × width) → its last hidden state (rows × width × dims). */
interface EmbeddingSession {
  run(inputIds: BigInt64Array, mask: BigInt64Array, rows: number, width: number): Promise<{ hidden: Float32Array; dims: number }>;
  release(): Promise<void>;
}

interface Loaded {
  session: EmbeddingSession;
  tokenizer: EmbedderTokenizer;
  frame: TokenFrame;
}

/**
 * A sentence-embedding transformer (multilingual-e5-small, or a BERT-style sentence-transformer)
 * on `onnxruntime-node` with the pure-JS `@huggingface/tokenizers`: the kind's prefix, the
 * tokenizer's own special tokens, truncation to `maxTokens` (counted and logged, never silent),
 * mean pooling over the attention mask, then L2 normalization. Nothing is loaded until the first
 * `embed`; a failed load is remembered (every later call rejects at once) until a new instance is
 * made.
 */
export class OnnxSentenceEmbedder implements KnowledgeEmbedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly thresholds: KnowledgeVectorThresholds;
  readonly maxTokens: number;
  private readonly modelDir: string;
  private readonly prefixes: Record<KnowledgeEmbedKind, string>;
  private readonly threads: number;
  private readonly batchSize: number;
  private readonly logger: Pick<Console, "warn">;
  private loading: Promise<Loaded> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: OnnxEmbedderOptions) {
    this.modelDir = join(options.modelDir, options.modelId);
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.maxTokens = Math.max(8, options.maxTokens ?? 256);
    this.prefixes = { query: options.queryPrefix ?? "", passage: options.passagePrefix ?? "" };
    this.threads = Math.max(1, options.threads ?? 2);
    this.batchSize = Math.max(1, options.batchSize ?? 16);
    this.thresholds = { ...(options.thresholds ?? MINILM_THRESHOLDS) };
    this.logger = options.logger ?? console;
  }

  /** Load the model now (optional; `embed` loads on demand). */
  warm(): Promise<void> {
    return this.load().then(() => undefined);
  }

  embed(texts: readonly string[], kind: KnowledgeEmbedKind = "passage"): Promise<Float32Array[]> {
    // One inference at a time per model: bounded CPU, predictable latency.
    const run = this.queue.then(() => this.embedNow(texts, kind));
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

  /** The ONNX session over `onnx/model_quantized.onnx`. */
  private async openSession(): Promise<EmbeddingSession> {
    const ortModule = (await import("onnxruntime-node")) as typeof Ort & { default?: typeof Ort };
    const ort = (ortModule.InferenceSession ? ortModule : ortModule.default) as typeof Ort;
    const session = await ort.InferenceSession.create(join(this.modelDir, "onnx", "model_quantized.onnx"), {
      executionProviders: ["cpu"],
      intraOpNumThreads: this.threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all"
    });
    const dimensions = this.dimensions;
    return {
      async run(inputIds, mask, rows, width) {
        const feeds: Record<string, Ort.Tensor> = {
          input_ids: new ort.Tensor("int64", inputIds, [rows, width]),
          attention_mask: new ort.Tensor("int64", mask, [rows, width])
        };
        if (session.inputNames.includes("token_type_ids")) {
          feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(rows * width), [rows, width]);
        }
        const result = await session.run(feeds);
        const output = result.last_hidden_state ?? result[session.outputNames[0]!]!;
        return { hidden: output.data as Float32Array, dims: output.dims[2] ?? dimensions };
      },
      release: () => session.release()
    };
  }

  private load(): Promise<Loaded> {
    if (this.disposed) return Promise.reject(new Error("the embedder was disposed"));
    this.loading ??= (async () => {
      const tokenizers = (await import("@huggingface/tokenizers")) as typeof import("@huggingface/tokenizers");
      const [tokenizerJson, tokenizerConfigJson] = await Promise.all([
        readFile(join(this.modelDir, "tokenizer.json"), "utf8"),
        readFile(join(this.modelDir, "tokenizer_config.json"), "utf8")
      ]);
      const tokenizerConfig = JSON.parse(tokenizerConfigJson) as unknown;
      const tokenizer: EmbedderTokenizer = new tokenizers.Tokenizer(JSON.parse(tokenizerJson), tokenizerConfig as object);
      const frame = tokenFrameOf(tokenizer, tokenizerConfig);
      const session = await this.openSession();
      return { session, tokenizer, frame };
    })();
    return this.loading;
  }

  private async embedNow(texts: readonly string[], kind: KnowledgeEmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const loaded = await this.load();
    const prefix = this.prefixes[kind] ?? "";
    let truncated = 0;
    const encoded = texts.map((text) => {
      const bare = loaded.tokenizer.encode(`${prefix}${text}`, { add_special_tokens: false }).ids;
      const framed = frameIds(loaded.frame, bare, this.maxTokens);
      if (framed.truncated) truncated += 1;
      return framed.ids;
    });
    if (truncated > 0) {
      // A count only: the texts are entry bodies and never reach the log.
      this.logger.warn(
        `knowledge: ${truncated} of ${texts.length} ${kind} text(s) exceeded ${this.maxTokens} tokens for ${this.modelId} and were truncated`
      );
    }
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

  private async runBatch(loaded: Loaded, batch: number[][]): Promise<Float32Array[]> {
    const rows = batch.length;
    const width = Math.max(...batch.map((ids) => ids.length));
    const inputIds = new BigInt64Array(rows * width).fill(BigInt(loaded.frame.pad));
    const mask = new BigInt64Array(rows * width);
    batch.forEach((ids, row) => {
      for (let i = 0; i < ids.length; i += 1) {
        inputIds[row * width + i] = BigInt(ids[i]!);
        mask[row * width + i] = 1n;
      }
    });
    const { hidden, dims } = await loaded.session.run(inputIds, mask, rows, width);
    return meanPoolNormalized(
      hidden,
      batch.map((ids) => ids.length),
      width,
      dims
    );
  }
}

/**
 * The embedder for the installed runtime (`KnowledgeRuntime.embedding*`), made lazily and
 * replaced (the old one released) when the runtime changes. Null while none is installed or while
 * the runtime lacks its model's files (`embeddingModelReady: false`, an install from before a
 * model change): search then runs on BM25 and the graph alone.
 */
export function runtimeEmbedderSource(
  runtime: KnowledgeRuntimePort,
  options: Pick<OnnxEmbedderOptions, "threads" | "batchSize" | "maxTokens" | "logger"> = {}
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
      const usable = rt !== null && rt.embeddingModelReady !== false;
      const spec = usable
        ? {
            modelDir: rt.embeddingModelDir,
            modelId: rt.embeddingModelId,
            dimensions: rt.embeddingDimensions,
            ...(rt.embeddingMaxTokens !== undefined ? { maxTokens: rt.embeddingMaxTokens } : {}),
            ...(rt.embeddingQueryPrefix !== undefined ? { queryPrefix: rt.embeddingQueryPrefix } : {}),
            ...(rt.embeddingPassagePrefix !== undefined ? { passagePrefix: rt.embeddingPassagePrefix } : {}),
            ...(rt.embeddingThresholds !== undefined ? { thresholds: rt.embeddingThresholds } : {})
          }
        : null;
      const next = spec ? JSON.stringify(spec) : null;
      if (next !== key) {
        void embedder?.dispose();
        embedder = spec ? new OnnxSentenceEmbedder({ ...options, ...spec }) : null;
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
