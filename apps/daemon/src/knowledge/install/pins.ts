/**
 * What the Knowledge Graph runtime installs, pinned (spec "Install and
 * updates"). Moving a pin means re-checking it here: the uv release's
 * published sha256 files, the myKG prompts against `../mykg-prompts/<line>/`,
 * the lock under `./locks/`, the tiktoken encodings, and the model files' hashes.
 */
import { createHash } from "node:crypto";
import type { HostLibc } from "../../plugins/ts-rust/installer.ts";
import type { KnowledgeVectorThresholds } from "../ports.ts";

// ---- uv (astral-sh/uv) -----------------------------------------------------------------------

export const UV_VERSION = "0.13.4";

/**
 * The standalone uv build of each supported host, and its archive's sha256 (as the release's
 * `.sha256` publishes it). Not Intel macOS: the pinned lock's cryptography 49.0.0 has no wheel
 * for it, and the install builds nothing from source.
 */
export const UV_BUILDS: Readonly<Record<string, { target: string; sha256: string }>> = {
  "linux-x64-glibc": {
    target: "x86_64-unknown-linux-gnu",
    sha256: "2b428396f12572d4429cf210ca234dd599a33b3af0958a4d5ed569d63e3f344f"
  },
  "linux-x64-musl": {
    target: "x86_64-unknown-linux-musl",
    sha256: "28d4385f9f9d1d1c7654d85b3855e0e2615b2f6cc13136a2edff858bbdc16ff1"
  },
  "linux-arm64-glibc": {
    target: "aarch64-unknown-linux-gnu",
    sha256: "1ae72b4718729e2ccc4f1ae2c6d1e531ca8467800e0546e9130b3886023a60ab"
  },
  "linux-arm64-musl": {
    target: "aarch64-unknown-linux-musl",
    sha256: "253a17cadcb659ae77a0fe3b9a2f1c14297528d480c421899e61e64d64f24e8f"
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1"
  }
};

export interface UvBuild {
  version: string;
  /** e.g. "x86_64-unknown-linux-gnu"; the archive holds `uv-<target>/uv`. */
  target: string;
  sha256: string;
  url: string;
  sha256Url: string;
}

/** The pinned uv build for this host, or null where uv ships none (the plugin is unsupported there). */
export function uvBuildFor(platform: string, arch: string, libc: HostLibc): UvBuild | null {
  const key = platform === "linux" ? `linux-${arch}-${libc}` : platform === "darwin" ? `darwin-${arch}` : null;
  const build = key ? UV_BUILDS[key] : undefined;
  if (!build) return null;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${build.target}.tar.gz`;
  return { version: UV_VERSION, target: build.target, sha256: build.sha256, url, sha256Url: `${url}.sha256` };
}

// ---- Python and myKG -------------------------------------------------------------------------

/** The managed CPython uv installs (its newest 3.12 build, fixed by the uv pin). */
export const PYTHON_VERSION = "3.12";

export const MYKG_PACKAGE = "mykg";
/** The tested myKG release Orquester ships with, and its wheel's sha256 on PyPI. */
export const MYKG_PINNED_VERSION = "0.4.10";
export const MYKG_PINNED_WHEEL_SHA256 = "f91e2636f3dcb44164487ba749f36ddb1579858159df8f9150280e5de7e804cd";
/** "Check for updates" offers newer patch releases of this minor line only; larger jumps come with Orquester. */
export const MYKG_LINE = "0.4";

export const PYPI = "https://pypi.org/pypi";

/**
 * The hashed lock of each shipped myKG version (`uv pip compile --universal
 * --python-version 3.12 --generate-hashes`, constrained to the versions in
 * myKG's own uv.lock of that release). A newer patch installs with these as
 * version constraints and its own wheel hash from PyPI.
 */
export const MYKG_LOCKS: Readonly<Record<string, string>> = {
  "0.4.10": "mykg-0.4.10.txt"
};

// ---- tiktoken's encodings --------------------------------------------------------------------

/** A tiktoken BPE file the runtime holds, so myKG never downloads it on first use. */
export interface TiktokenEncodingSpec {
  /** e.g. "cl100k_base" (what `chunking.tiktoken_encoding` names). */
  name: string;
  /** The URL tiktoken loads it from; its cache file is named by the sha1 of this exact string. */
  url: string;
  /** sha256 hex of the file: the `expected_hash` tiktoken checks a cached copy against. */
  sha256: string;
  size: number;
}

/**
 * The encodings myKG loads (tiktoken 0.13.0 `tiktoken_ext/openai_public.py`). myKG 0.4.10
 * calls `tiktoken.get_encoding` only with `chunking.tiktoken_encoding` (`chunker.py`; the
 * `context_calculator` utility, which linking never runs, defaults to the same), and the
 * generated config sets `MYKG_TIKTOKEN_ENCODING` (cl100k_base). No other package in the lock
 * loads an encoding.
 */
export const TIKTOKEN_ENCODINGS: readonly TiktokenEncodingSpec[] = [
  {
    name: "cl100k_base",
    url: "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken",
    sha256: "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
    size: 1_681_126
  }
];

/** tiktoken's cache file name for `url` (`tiktoken/load.py` `read_file_cached`: sha1 of the URL). */
export function tiktokenCacheKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

// ---- the embedding model ---------------------------------------------------------------------

/**
 * multilingual-e5-small (retrieval spec P0.1): 384-d like the all-MiniLM-L6-v2 it replaces, but
 * multilingual (the knowledge base mixes English and Spanish), asymmetric ("query: " / "passage: ")
 * and trained on 512 tokens. Xenova's repo is intfloat/multilingual-e5-small exported to ONNX,
 * with an XLM-R tokenizer (`<s>`, `</s>`, `<pad>`).
 */
export const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
/** The Hugging Face commit the files below were hashed at. */
export const EMBEDDING_MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const EMBEDDING_DIMENSIONS = 384;
/** e5's input limit (`max_position_embeddings`), special tokens included. */
export const EMBEDDING_MAX_TOKENS = 512;

/**
 * The files the embedder loads, laid out under `<embeddingModelDir>/<EMBEDDING_MODEL_ID>/`, with
 * their sha256 (the quantized ONNX export is ~113 MiB: the 250k-token vocabulary is most of it).
 */
export const EMBEDDING_MODEL_FILES: readonly { path: string; sha256: string; size: number }[] = [
  { path: "config.json", sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1", size: 658 },
  { path: "tokenizer.json", sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39", size: 17_082_730 },
  { path: "tokenizer_config.json", sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b", size: 443 },
  { path: "special_tokens_map.json", sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7", size: 167 },
  { path: "onnx/model_quantized.onnx", sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193", size: 118_308_185 }
];

/**
 * The model's cosine cut-offs, calibrated on the evaluation set (`../search/eval/`, 30 entries,
 * 22 queries) with this pin, embedding as search does: queries as "query: " + text, passages as
 * "passage: " + `embeddingPassage(embeddingHeader(meta), chunk)`. Measured 2026-10-27
 * (`calibrationData`, printed by eval.test.ts with ORQUESTER_KG_MODEL_DIR set):
 *
 *   query → answer's best chunk      n=24   min 0.789  p10 0.822  p50 0.881  p90 0.913  max 0.916
 *   query → non-answer's best chunk  n=636  min 0.731  p10 0.754  p50 0.785  p90 0.818  max 0.874
 *   query → hardest non-answer       n=22   min 0.808  p10 0.814  p50 0.836  p90 0.848  max 0.874
 *   entry ↔ entry, near-copies       n=2    min 0.987                                   max 0.993
 *   entry ↔ entry, same topic        n=57   min 0.779  p10 0.789  p50 0.827  p90 0.862  max 0.885
 *   entry ↔ entry, other topics      n=376  min 0.734  p10 0.767  p50 0.799  p90 0.833  max 0.883
 *
 * minimum 0.78: under every answer, over about half the non-answers. good 0.83: about 85% of
 * answers, under 10% of non-answers. strong 0.87: about half the answers, only the hardest
 * non-answer or two. duplicate 0.95: well above any two distinct entries (≤ 0.885), below every
 * near-copy (≥ 0.987).
 */
export const EMBEDDING_MODEL_THRESHOLDS: KnowledgeVectorThresholds = { minimum: 0.78, good: 0.83, strong: 0.87, duplicate: 0.95 };

export function embeddingModelFileUrl(path: string): string {
  return `https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/${path}`;
}

/** The model the installer fetches and the embedder runs (the pinned one; tests pass a fixture). */
export interface EmbeddingModelSpec {
  id: string;
  revision: string;
  dimensions: number;
  files: readonly { path: string; sha256: string; size: number }[];
  fileUrl(path: string): string;
  /** Put before a search query when it is embedded ("" for a symmetric model). */
  queryPrefix: string;
  /** Put before every stored chunk when it is embedded. */
  passagePrefix: string;
  /** Tokens per input, special tokens included; a longer input is truncated (and counted). */
  maxTokens: number;
  thresholds: KnowledgeVectorThresholds;
}

export const EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: EMBEDDING_MODEL_ID,
  revision: EMBEDDING_MODEL_REVISION,
  dimensions: EMBEDDING_DIMENSIONS,
  files: EMBEDDING_MODEL_FILES,
  fileUrl: embeddingModelFileUrl,
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  maxTokens: EMBEDDING_MAX_TOKENS,
  thresholds: EMBEDDING_MODEL_THRESHOLDS
};
