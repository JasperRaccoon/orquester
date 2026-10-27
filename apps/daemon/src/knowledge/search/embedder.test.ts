import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InferenceSession, Tensor } from "onnxruntime-node";
import type { KnowledgeRuntime } from "../ports.ts";
import { OnnxSentenceEmbedder, type OnnxEmbedderOptions, runtimeEmbedderSource } from "./embedder.ts";

// A real tokenizer with XLM-R's <s>/</s>/<pad> ids. Only the native inference dependency is
// replaced: inputs remain observable at its protocol boundary and pooling runs in production.
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

function nativeSession(t: TestContext) {
  const state = { batches: [] as { ids: number[]; mask: number[] }[], released: 0 };
  t.mock.method(InferenceSession, "create", async () => ({
    inputNames: ["input_ids", "attention_mask"],
    outputNames: ["last_hidden_state"],
    async run(feeds: Record<string, Tensor>) {
      const [rows, width] = feeds.input_ids!.dims as [number, number];
      const ids = feeds.input_ids!.data as BigInt64Array;
      const masks = feeds.attention_mask!.data as BigInt64Array;
      const hidden = new Float32Array(rows * width * 2);
      for (let row = 0; row < rows; row += 1) {
        state.batches.push({
          ids: [...ids.slice(row * width, (row + 1) * width)].map(Number),
          mask: [...masks.slice(row * width, (row + 1) * width)].map(Number)
        });
        for (let col = 0; col < width; col += 1) {
          const token = Number(ids[row * width + col]);
          // The 3-4-5 triangle gives literal normalized outputs. Large padding states make an
          // unmasked mean fail, while distinct rows expose losing the caller's input order.
          const value = token === ID.hello || token === ID.world ? [3, 4]
            : token === ID.ads ? [4, 3] : token === ID.tiktok ? [-2, 0]
            : token === ID["<pad>"] ? [100, 100] : [0, 0];
          hidden.set(value, (row * width + col) * 2);
        }
      }
      return { last_hidden_state: new Tensor("float32", hidden, [rows, width, 2]) };
    },
    async release() { state.released += 1; }
  } as unknown as InferenceSession));
  return state;
}

function embedder(dir: string, options: Partial<OnnxEmbedderOptions> = {}) {
  const warnings: string[] = [];
  const e = new OnnxSentenceEmbedder({
    modelDir: dir, modelId: "Fixture/xlmr-tiny", dimensions: 2,
    queryPrefix: "query: ", passagePrefix: "passage: ", maxTokens: 8,
    logger: { warn: (line: string) => warnings.push(line) }, ...options
  });
  return { embedder: e, warnings };
}

const realTokens = (row: { ids: number[]; mask: number[] }) => row.ids.filter((_, i) => row.mask[i] === 1);
const close = (actual: Float32Array, expected: number[]) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, i) => assert.ok(Math.abs(actual[i]! - value) < 1e-6, `${actual} != ${expected}`));
};

test("embed preserves input order, prefixes and tokenizer framing, and normalizes a masked mean", async (t) => {
  const native = nativeSession(t);
  const { embedder: e, warnings } = embedder(await modelDir(t));
  t.after(() => e.dispose());
  const [q] = await e.embed(["hello world"], "query");
  const [p, short] = await e.embed(["hello world paywall", "ads"], "passage");
  const [plain] = await e.embed(["tiktok"]);

  assert.deepEqual(realTokens(native.batches[0]!), [0, 4, 6, 7, 2]);
  const passageRows = native.batches.slice(1, 3);
  assert.deepEqual(realTokens(passageRows.find((row) => row.ids.includes(ID.paywall))!), [0, 5, 6, 7, 8, 2]);
  const ads = passageRows.find((row) => row.ids.includes(ID.ads))!;
  assert.deepEqual(realTokens(ads), [0, 5, 9, 2]);
  ads.ids.forEach((token, i) => { if (ads.mask[i] === 0) assert.equal(token, 1); });
  assert.deepEqual(realTokens(native.batches[3]!), [0, 5, 10, 2]);
  close(q!, [0.6, 0.8]);
  close(p!, [0.6, 0.8]);
  close(short!, [0.8, 0.6]);
  close(plain!, [-1, 0]);
  assert.deepEqual(warnings, []);
});

test("oversize inputs close at maxTokens and log only a truncation count", async (t) => {
  const native = nativeSession(t);
  const { embedder: e, warnings } = embedder(await modelDir(t));
  t.after(() => e.dispose());
  const secret = "hello world paywall ads tiktok hello world";
  await e.embed([secret, "ads", `${secret} tiktok`], "passage");
  const long = native.batches.map(realTokens).filter((row) => row.length > 4);
  assert.deepEqual(long, [[0, 5, 6, 7, 8, 9, 10, 2], [0, 5, 6, 7, 8, 9, 10, 2]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\b2 of 3\b/);
  assert.match(warnings[0]!, /\b8 tokens\b/);
  assert.ok(!warnings[0]!.includes("paywall"));
  await e.embed(["ads"], "query");
  assert.equal(warnings.length, 1);
});

test("legacy symmetric model inputs are unprefixed and limited to 256 tokens by default", async (t) => {
  const native = nativeSession(t);
  const e = new OnnxSentenceEmbedder({ modelDir: await modelDir(t), modelId: "Fixture/xlmr-tiny", dimensions: 2, logger: { warn() {} } });
  t.after(() => e.dispose());
  await e.embed(["hello"], "query");
  assert.deepEqual(realTokens(native.batches[0]!), [0, 6, 2]);
  await e.embed(["hello ".repeat(300)]);
  assert.equal(realTokens(native.batches[1]!).length, 256);
  assert.equal(realTokens(native.batches[1]!).at(-1), 2);
});

test("dispose releases the native session and refuses further embedding", async (t) => {
  const native = nativeSession(t);
  const { embedder: e } = embedder(await modelDir(t));
  await e.embed(["hello"]);
  await e.dispose();
  assert.equal(native.released, 1);
  await assert.rejects(e.embed(["hello"]), /disposed/);
});

function fakeRuntime(dir: string, extra: Partial<KnowledgeRuntime> = {}): KnowledgeRuntime {
  return {
    mykgVersion: "0.4.10", mykgBin: "/x/mykg", pythonBin: "/x/python", tiktokenCacheDir: "/x/tiktoken",
    embeddingModelDir: dir, embeddingModelId: "Fixture/xlmr-tiny", embeddingDimensions: 2,
    embeddingModelReady: true, embeddingQueryPrefix: "query: ", embeddingPassagePrefix: "passage: ",
    embeddingMaxTokens: 8, embeddingThresholds: { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 }, ...extra
  };
}

test("runtime availability and model changes configure actual embedding and preserve legacy defaults", async (t) => {
  const native = nativeSession(t);
  const dir = await modelDir(t);
  let runtime: KnowledgeRuntime | null = null;
  const listeners = new Set<(rt: KnowledgeRuntime | null) => void>();
  const source = runtimeEmbedderSource({
    current: () => runtime,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  }, { logger: { warn() {} } });
  t.after(() => source.dispose());
  let changes = 0;
  source.onChange(() => { changes += 1; });
  assert.equal(source.current(), null);
  runtime = fakeRuntime(dir, { embeddingModelReady: false });
  for (const listener of listeners) listener(runtime);
  assert.equal(changes, 1);
  assert.equal(source.current(), null);

  runtime = fakeRuntime(dir);
  const ready = source.current()!;
  await ready.embed(["hello ".repeat(20)], "query");
  assert.deepEqual(realTokens(native.batches[0]!), [0, 4, 6, 6, 6, 6, 6, 2]);
  assert.deepEqual(ready.thresholds, { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 });
  assert.equal(source.current(), ready);

  // Persisted runtimes written before the new embedding fields remain usable.
  runtime = { mykgVersion: "0.4.10", mykgBin: "/x", pythonBin: "/x", tiktokenCacheDir: "/x",
    embeddingModelDir: dir, embeddingModelId: "Fixture/xlmr-tiny", embeddingDimensions: 2 };
  const legacy = source.current()!;
  await legacy.embed(["hello"], "query");
  assert.deepEqual(realTokens(native.batches[1]!), [0, 6, 2]);
  assert.equal(native.released, 1);
  await assert.rejects(ready.embed(["hello"]), /disposed/);
});
