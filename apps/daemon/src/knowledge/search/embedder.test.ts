import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Tokenizer } from "@huggingface/tokenizers";
import type { KnowledgeRuntime } from "../ports.ts";
import {
  type EmbeddingSession,
  MINILM_THRESHOLDS,
  OnnxSentenceEmbedder,
  type OnnxEmbedderOptions,
  frameIds,
  meanPoolNormalized,
  runtimeEmbedderSource,
  tokenFrameOf
} from "./embedder.ts";

// The ONNX embedder without ONNX: a tiny XLM-R-shaped tokenizer (`<s>` 0, `<pad>` 1, `</s>` 2 —
// not BERT's 101/102/0) on disk and a fake session that echoes each position's token id, so the
// prefixes, the special tokens, the padding, truncation (and its log line) and the pooling are
// all visible. The real model is exercised by embedder.model.test.ts.

const VOCAB = ["<s>", "<pad>", "</s>", "<unk>", "query:", "passage:", "hello", "world", "paywall", "ads", "tiktok"];
const ID = Object.fromEntries(VOCAB.map((token, id) => [token, id])) as Record<string, number>;

function tokenizerJson(): unknown {
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: VOCAB.slice(0, 4).map((content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
    normalizer: null,
    pre_tokenizer: { type: "WhitespaceSplit" },
    post_processor: {
      type: "TemplateProcessing",
      single: [{ SpecialToken: { id: "<s>", type_id: 0 } }, { Sequence: { id: "A", type_id: 0 } }, { SpecialToken: { id: "</s>", type_id: 0 } }],
      pair: [
        { SpecialToken: { id: "<s>", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "</s>", type_id: 0 } },
        { Sequence: { id: "B", type_id: 0 } },
        { SpecialToken: { id: "</s>", type_id: 0 } }
      ],
      special_tokens: { "<s>": { id: "<s>", ids: [0], tokens: ["<s>"] }, "</s>": { id: "</s>", ids: [2], tokens: ["</s>"] } }
    },
    decoder: null,
    model: { type: "WordPiece", unk_token: "<unk>", continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab: ID }
  };
}

const TOKENIZER_CONFIG = { bos_token: "<s>", cls_token: "<s>", eos_token: "</s>", sep_token: "</s>", pad_token: "<pad>", unk_token: "<unk>", model_max_length: 512 };

async function modelDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kg-embedder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Fixture", "xlmr-tiny"), { recursive: true });
  await writeFile(join(root, "Fixture", "xlmr-tiny", "tokenizer.json"), JSON.stringify(tokenizerJson()));
  await writeFile(join(root, "Fixture", "xlmr-tiny", "tokenizer_config.json"), JSON.stringify(TOKENIZER_CONFIG));
  return root;
}

/** Each position's hidden state is a one-hot of its token id (dims = vocabulary size), so pooling shows which tokens counted. */
class EchoEmbedder extends OnnxSentenceEmbedder {
  batches: { ids: number[][]; mask: number[][] }[] = [];
  released = 0;
  protected override async openSession(): Promise<EmbeddingSession> {
    return {
      run: async (inputIds, mask, rows, width) => {
        const dims = VOCAB.length;
        const hidden = new Float32Array(rows * width * dims);
        const ids: number[][] = [];
        const masks: number[][] = [];
        for (let r = 0; r < rows; r += 1) {
          ids.push([...inputIds.slice(r * width, (r + 1) * width)].map(Number));
          masks.push([...mask.slice(r * width, (r + 1) * width)].map(Number));
          for (let c = 0; c < width; c += 1) hidden[(r * width + c) * dims + Number(inputIds[r * width + c])] = 1;
        }
        this.batches.push({ ids, mask: masks });
        return { hidden, dims };
      },
      release: async () => {
        this.released += 1;
      }
    };
  }
}

function embedder(dir: string, options: Partial<OnnxEmbedderOptions> = {}): { embedder: EchoEmbedder; warnings: string[] } {
  const warnings: string[] = [];
  const e = new EchoEmbedder({
    modelDir: dir,
    modelId: "Fixture/xlmr-tiny",
    dimensions: VOCAB.length,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    maxTokens: 8,
    thresholds: { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 },
    logger: { warn: (line: string) => warnings.push(line) },
    ...options
  });
  return { embedder: e, warnings };
}

test("the frame comes from the tokenizer: <s> … </s> and <pad>, not BERT's ids", () => {
  const tokenizer = new Tokenizer(tokenizerJson() as object, TOKENIZER_CONFIG);
  assert.deepEqual(tokenFrameOf(tokenizer, TOKENIZER_CONFIG), { before: [ID["<s>"]], after: [ID["</s>"]], pad: ID["<pad>"] });
  // An AddedToken-style pad_token; no pad_token at all falls back to the end token.
  assert.equal(tokenFrameOf(tokenizer, { pad_token: { content: "<pad>" } }).pad, ID["<pad>"]);
  assert.equal(tokenFrameOf(tokenizer, {}).pad, ID["</s>"]);
});

test("truncation keeps the start and closes with the model's end token", () => {
  const frame = { before: [0], after: [2], pad: 1 };
  assert.deepEqual(frameIds(frame, [5, 6, 7], 8), { ids: [0, 5, 6, 7, 2], truncated: false });
  assert.deepEqual(frameIds(frame, [5, 6, 7, 8, 9, 10, 11], 8), { ids: [0, 5, 6, 7, 8, 9, 10, 2], truncated: true });
  assert.deepEqual(frameIds(frame, [5, 6, 7, 8, 9, 10, 11, 12], 8), { ids: [0, 5, 6, 7, 8, 9, 10, 2], truncated: true });
  assert.deepEqual(frameIds({ before: [101], after: [102, 102], pad: 0 }, [5, 6, 7, 8], 5), { ids: [101, 5, 6, 102, 102], truncated: true });
});

test("mean pooling counts only the real tokens of each row, then L2-normalizes", () => {
  // Two rows, width 3, dims 2; row 1 has one padded position whose state must not count.
  const hidden = new Float32Array([1, 0, 0, 1, 1, 1, 3, 4, 3, 4, 100, 100]);
  const [a, b] = meanPoolNormalized(hidden, [3, 2], 3, 2);
  const norm = Math.hypot(2 / 3, 2 / 3);
  assert.ok(Math.abs(a![0]! - 2 / 3 / norm) < 1e-6 && Math.abs(a![1]! - 2 / 3 / norm) < 1e-6);
  assert.ok(Math.abs(b![0]! - 0.6) < 1e-6 && Math.abs(b![1]! - 0.8) < 1e-6);
});

test("embed applies the kind's prefix, the tokenizer's special tokens and its padding", async (t) => {
  const dir = await modelDir(t);
  const { embedder: e, warnings } = embedder(dir);
  t.after(() => e.dispose());
  const [q] = await e.embed(["hello world"], "query");
  const [p, short] = await e.embed(["hello world paywall", "ads"], "passage");
  const [plain] = await e.embed(["tiktok"]);

  assert.deepEqual(e.batches[0]!.ids, [[ID["<s>"], ID["query:"], ID.hello, ID.world, ID["</s>"]]]);
  // Sorted by length within the call; the shorter row is padded with <pad> and masked out.
  assert.deepEqual(e.batches[1]!.ids, [
    [ID["<s>"], ID["passage:"], ID.ads, ID["</s>"], ID["<pad>"], ID["<pad>"]],
    [ID["<s>"], ID["passage:"], ID.hello, ID.world, ID.paywall, ID["</s>"]]
  ]);
  assert.deepEqual(e.batches[1]!.mask, [
    [1, 1, 1, 1, 0, 0],
    [1, 1, 1, 1, 1, 1]
  ]);
  // "passage" is the default kind.
  assert.deepEqual(e.batches[2]!.ids, [[ID["<s>"], ID["passage:"], ID.tiktok, ID["</s>"]]]);

  // Each vector is the normalized mean of its own tokens' one-hots: padding never counts.
  const expect = (tokens: string[]) => {
    const v = new Float32Array(VOCAB.length);
    for (const token of tokens) v[ID[token]!]! += 1 / tokens.length;
    const n = Math.hypot(...v);
    return [...v].map((x) => x / n);
  };
  const close = (a: Float32Array, b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-6);
  assert.ok(close(q!, expect(["<s>", "query:", "hello", "world", "</s>"])));
  assert.ok(close(p!, expect(["<s>", "passage:", "hello", "world", "paywall", "</s>"])));
  assert.ok(close(short!, expect(["<s>", "passage:", "ads", "</s>"])));
  assert.ok(close(plain!, expect(["<s>", "passage:", "tiktok", "</s>"])));
  assert.deepEqual(warnings, []);
  assert.deepEqual(e.thresholds, { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 });
});

test("inputs past maxTokens are truncated, closed with </s>, and counted in one warning per call (no text)", async (t) => {
  const dir = await modelDir(t);
  const { embedder: e, warnings } = embedder(dir, { maxTokens: 8 });
  t.after(() => e.dispose());
  const secret = "hello world paywall ads tiktok hello world";
  await e.embed([secret, "ads", `${secret} tiktok`], "passage");
  const rows = e.batches[0]!.ids;
  assert.deepEqual(rows.at(-1), [ID["<s>"], ID["passage:"], ID.hello, ID.world, ID.paywall, ID.ads, ID.tiktok, ID["</s>"]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^knowledge: 2 of 3 passage text\(s\) exceeded 8 tokens for Fixture\/xlmr-tiny and were truncated$/);
  assert.ok(!warnings[0]!.includes("paywall"));
  await e.embed(["ads"], "query");
  assert.equal(warnings.length, 1, "nothing truncated, nothing logged");
});

test("a symmetric model has no prefixes; the defaults are all-MiniLM-L6-v2's", async (t) => {
  const dir = await modelDir(t);
  const e = new EchoEmbedder({ modelDir: dir, modelId: "Fixture/xlmr-tiny", dimensions: VOCAB.length, logger: { warn: () => {} } });
  t.after(() => e.dispose());
  await e.embed(["hello"], "query");
  assert.deepEqual(e.batches[0]!.ids, [[ID["<s>"], ID.hello, ID["</s>"]]]);
  assert.deepEqual(e.thresholds, MINILM_THRESHOLDS);
  assert.equal(e.maxTokens, 256);
});

test("dispose releases the session; a disposed embedder refuses", async (t) => {
  const dir = await modelDir(t);
  const { embedder: e } = embedder(dir);
  await e.embed(["hello"]);
  await e.dispose();
  assert.equal(e.released, 1);
  await assert.rejects(e.embed(["hello"]), /disposed/);
});

function fakeRuntime(dir: string, extra: Partial<KnowledgeRuntime> = {}): KnowledgeRuntime {
  return {
    mykgVersion: "0.4.10",
    mykgBin: "/x/mykg",
    pythonBin: "/x/python",
    tiktokenCacheDir: "/x/tiktoken",
    embeddingModelDir: dir,
    embeddingModelId: "Fixture/xlmr-tiny",
    embeddingDimensions: VOCAB.length,
    embeddingModelReady: true,
    embeddingQueryPrefix: "query: ",
    embeddingPassagePrefix: "passage: ",
    embeddingMaxTokens: 512,
    embeddingThresholds: { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 },
    ...extra
  };
}

test("the runtime source passes the model's prefixes, limit and thresholds; none while the model is missing", async () => {
  let runtime: KnowledgeRuntime | null = null;
  const listeners = new Set<(rt: KnowledgeRuntime | null) => void>();
  const source = runtimeEmbedderSource({
    current: () => runtime,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
  let changes = 0;
  source.onChange(() => (changes += 1));
  assert.equal(source.current(), null);

  // myKG installed with an older model: linking runs, search has no embedder (text and graph only).
  runtime = fakeRuntime("/models", { embeddingModelReady: false });
  for (const listener of listeners) listener(runtime);
  assert.equal(changes, 1);
  assert.equal(source.current(), null);

  runtime = fakeRuntime("/models");
  const ready = source.current() as OnnxSentenceEmbedder;
  assert.ok(ready instanceof OnnxSentenceEmbedder);
  assert.equal(ready.modelId, "Fixture/xlmr-tiny");
  assert.equal(ready.maxTokens, 512);
  assert.deepEqual(ready.thresholds, { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 });
  assert.equal(source.current(), ready, "the same runtime keeps the same embedder");

  // A runtime written before these fields (an older daemon's fake): all-MiniLM-L6-v2's defaults.
  runtime = {
    mykgVersion: "0.4.10",
    mykgBin: "/x",
    pythonBin: "/x",
    tiktokenCacheDir: "/x",
    embeddingModelDir: "/models",
    embeddingModelId: "Xenova/all-MiniLM-L6-v2",
    embeddingDimensions: 384
  };
  const legacy = source.current() as OnnxSentenceEmbedder;
  assert.notEqual(legacy, ready);
  assert.deepEqual(legacy.thresholds, MINILM_THRESHOLDS);
  assert.equal(legacy.maxTokens, 256);
  await source.dispose();
});
