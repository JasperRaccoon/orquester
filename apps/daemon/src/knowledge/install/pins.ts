/**
 * What the Knowledge Graph runtime installs, pinned (spec "Install and
 * updates"). Moving a pin means re-checking it here: the uv release's
 * published sha256 files, the myKG prompts against `../mykg-prompts/<line>/`,
 * the lock under `./locks/`, the tiktoken encodings, and the model files' hashes.
 */
import { createHash } from "node:crypto";
import type { HostLibc } from "../../plugins/ts-rust/installer.ts";

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

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
/** The Hugging Face commit the files below were hashed at. */
export const EMBEDDING_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const EMBEDDING_DIMENSIONS = 384;

/**
 * The files a transformers.js `localModelPath` needs, laid out under
 * `<embeddingModelDir>/<EMBEDDING_MODEL_ID>/`, with their sha256.
 */
export const EMBEDDING_MODEL_FILES: readonly { path: string; sha256: string; size: number }[] = [
  { path: "config.json", sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7", size: 650 },
  { path: "tokenizer.json", sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0", size: 711_661 },
  { path: "tokenizer_config.json", sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3", size: 366 },
  { path: "special_tokens_map.json", sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3", size: 125 },
  { path: "onnx/model_quantized.onnx", sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1", size: 22_972_370 }
];

export function embeddingModelFileUrl(path: string): string {
  return `https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/${path}`;
}

/** The model the installer fetches (the pinned one; tests pass a fixture). */
export interface EmbeddingModelSpec {
  id: string;
  revision: string;
  dimensions: number;
  files: readonly { path: string; sha256: string; size: number }[];
  fileUrl(path: string): string;
}

export const EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: EMBEDDING_MODEL_ID,
  revision: EMBEDDING_MODEL_REVISION,
  dimensions: EMBEDDING_DIMENSIONS,
  files: EMBEDDING_MODEL_FILES,
  fileUrl: embeddingModelFileUrl
};
