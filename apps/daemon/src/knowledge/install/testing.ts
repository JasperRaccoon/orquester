// Test support for the Knowledge Graph runtime installer: a uv release tarball
// built on the spot, a tiny embedding-model fixture, an in-memory network
// (GitHub release, PyPI, Hugging Face) and a fake process runner that plays uv
// (python install, venv, pip install) and `mykg --help` by writing the files
// the real ones would. Nothing here touches the network or runs Python.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CommandOptions, CommandResult, KnowledgeInstallerDeps } from "./installer.ts";
import { type EmbeddingModelSpec, MYKG_PINNED_VERSION, MYKG_PINNED_WHEEL_SHA256, PYPI, UV_VERSION, type UvBuild } from "./pins.ts";

const exec = promisify(execFile);

/** Every prompt file myKG 0.4.10 ships (`src/mykg/prompts/**`). */
export const MYKG_0_4_PROMPT_FILES: readonly string[] = [
  "feedback/normalize_system.txt",
  "feedback/orphan_connect_system.txt",
  "feedback/schema_extend_system.txt",
  "feedback/schema_system.txt",
  "feedback/user_template.txt",
  "normalize/system.txt",
  "orphan/chunk_recovery_system.txt",
  "orphan/pair_confirm_system.txt",
  "orphan/schema_gap_system.txt",
  "pass1/system.txt",
  "pass2/system.txt",
  "schema_merge/harmonize_system.txt",
  "schema_merge/merge_harmonize_system.txt",
  "schema_merge/merge_quality_system.txt",
  "schema_merge/quality_system.txt"
];

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A uv release archive (`uv-<target>/uv`, a shell script) under `dir`, and the build that names it. */
export async function makeUvBuild(dir: string, target = "x86_64-unknown-linux-gnu"): Promise<{ build: UvBuild; tgz: Buffer }> {
  const src = await mkdtemp(join(dir, "uv-src-"));
  await mkdir(join(src, `uv-${target}`));
  // Shipped without the exec bit: the installer must chmod it.
  await writeFile(join(src, `uv-${target}`, "uv"), "#!/bin/sh\necho uv-fixture\n", { mode: 0o644 });
  const file = join(dir, `uv-${target}-${Date.now()}.tar.gz`);
  await exec("tar", ["-czf", file, "-C", src, `uv-${target}`]);
  const tgz = await readFile(file);
  const url = `https://github.invalid/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`;
  return { tgz, build: { version: UV_VERSION, target, sha256: sha256(tgz), url, sha256Url: `${url}.sha256` } };
}

/** A two-file embedding model fixture. */
export function makeModel(): { spec: EmbeddingModelSpec; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>([
    ["config.json", Buffer.from('{"model_type":"bert"}\n')],
    ["onnx/model_quantized.onnx", Buffer.from("fake-onnx-bytes")]
  ]);
  const spec: EmbeddingModelSpec = {
    id: "Fixture/mini-model",
    revision: "0123456789abcdef0123456789abcdef01234567",
    dimensions: 384,
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length })),
    fileUrl: (path) => `https://hf.invalid/Fixture/mini-model/resolve/rev/${path}`
  };
  return { spec, files };
}

export interface FakeRunCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface FakeKnowledgeHost {
  deps: KnowledgeInstallerDeps;
  /** Downloadable bytes by URL. */
  downloads: Map<string, Buffer>;
  /** Text bodies by URL (the `.sha256` files). */
  texts: Map<string, string>;
  /** PyPI's myKG releases: version → its files' JSON as PyPI lists them. */
  pypi: Map<string, unknown[]>;
  calls: { json: string[]; downloads: string[]; texts: string[]; run: FakeRunCall[] };
  /** Prompt files `pip install` leaves out of the package (a renamed prompt). */
  omitPrompts: Set<string>;
  /** What `mykg --help` answers. */
  smoke: CommandResult;
  /** Make the next `uv <subcommand>` fail with this stderr. */
  failUv: Map<string, string>;
  /** Called at the start of every download (to block or fail one). */
  onDownload: ((url: string, signal: AbortSignal) => Promise<void>) | null;
  /** Set to make every PyPI request fail. */
  pypiDown: boolean;
}

/** A wheel file entry as PyPI's JSON lists it. */
export function pypiWheel(version: string, sha: string, options: { yanked?: boolean } = {}): unknown {
  return {
    filename: `mykg-${version}-py3-none-any.whl`,
    packagetype: "bdist_wheel",
    yanked: options.yanked === true,
    digests: { sha256: sha }
  };
}

/**
 * The fake host: serves `uv` (from {@link makeUvBuild}), the model files and
 * PyPI's myKG index (the pinned 0.4.10 by default), and plays uv and mykg.
 */
export function fakeKnowledgeHost(options: {
  uv: { build: UvBuild; tgz: Buffer };
  model: { spec: EmbeddingModelSpec; files: Map<string, Buffer> };
  now?: string;
}): FakeKnowledgeHost {
  const { build, tgz } = options.uv;
  const host: FakeKnowledgeHost = {
    downloads: new Map([[build.url, tgz]]),
    texts: new Map([[build.sha256Url, `${build.sha256}  uv-${build.target}.tar.gz\n`]]),
    pypi: new Map([[MYKG_PINNED_VERSION, [pypiWheel(MYKG_PINNED_VERSION, MYKG_PINNED_WHEEL_SHA256)]]]),
    calls: { json: [], downloads: [], texts: [], run: [] },
    omitPrompts: new Set(),
    smoke: { exitCode: 0, stdout: "Usage: mykg [OPTIONS] COMMAND [ARGS]...\n\nCommands:\n  extract-graph\n  query\n", stderr: "", timedOut: false },
    failUv: new Map(),
    onDownload: null,
    pypiDown: false,
    deps: undefined as never
  };
  for (const [path, bytes] of options.model.files) host.downloads.set(options.model.spec.fileUrl(path), bytes);

  const run = async (command: string, args: readonly string[], opts: CommandOptions): Promise<CommandResult> => {
    host.calls.run.push({ command, args: [...args], env: { ...opts.env }, cwd: opts.cwd });
    const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.endsWith("/uv")) {
      const sub = args[0] ?? "";
      const failure = host.failUv.get(sub);
      if (failure !== undefined) {
        host.failUv.delete(sub);
        return { exitCode: 2, stdout: "", stderr: `error: ${failure}\n`, timedOut: false };
      }
      if (sub === "python") {
        const bin = join(opts.env.UV_PYTHON_INSTALL_DIR ?? "", "cpython-3.12.12-fixture", "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, "python3.12"), "#!/bin/sh\n", { mode: 0o755 });
        return ok;
      }
      if (sub === "venv") {
        const venv = args.at(-1) ?? "";
        await mkdir(join(venv, "bin"), { recursive: true });
        await mkdir(join(venv, "lib", "python3.12", "site-packages"), { recursive: true });
        await writeFile(join(venv, "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
        await writeFile(join(venv, "pyvenv.cfg"), "relocatable = true\n");
        return ok;
      }
      if (sub === "pip") {
        const python = args[args.indexOf("--python") + 1] ?? "";
        const venv = dirname(dirname(python));
        const prompts = join(venv, "lib", "python3.12", "site-packages", "mykg", "prompts");
        for (const file of MYKG_0_4_PROMPT_FILES) {
          if (host.omitPrompts.has(file)) continue;
          await mkdir(dirname(join(prompts, file)), { recursive: true });
          await writeFile(join(prompts, file), `UPSTREAM ${file}\n`);
        }
        await writeFile(join(venv, "bin", "mykg"), "#!/bin/sh\n", { mode: 0o755 });
        return ok;
      }
      return { exitCode: 2, stdout: "", stderr: `error: unknown uv command ${sub}\n`, timedOut: false };
    }
    if (command.endsWith("/bin/mykg")) return { ...host.smoke };
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" };
  };

  host.deps = {
    fetchJson: async (url) => {
      host.calls.json.push(url);
      if (host.pypiDown) throw new Error(`HTTP 503 from ${url}`);
      if (url === `${PYPI}/mykg/json`) {
        return { info: { name: "mykg" }, releases: Object.fromEntries(host.pypi) };
      }
      const match = new RegExp(`^${PYPI.replace(/[.]/g, "\\.")}/mykg/([^/]+)/json$`).exec(url);
      const files = match ? host.pypi.get(decodeURIComponent(match[1] ?? "")) : undefined;
      if (!match || !files) throw new Error(`HTTP 404 from ${url}`);
      return { info: { name: "mykg", version: decodeURIComponent(match[1] ?? "") }, urls: files };
    },
    fetchText: async (url) => {
      host.calls.texts.push(url);
      const text = host.texts.get(url);
      if (text === undefined) throw new Error(`HTTP 404 from ${url}`);
      return text;
    },
    download: async (url, dest, signal) => {
      host.calls.downloads.push(url);
      if (host.onDownload) await host.onDownload(url, signal);
      const bytes = host.downloads.get(url);
      if (!bytes) throw new Error(`HTTP 404 from ${url}`);
      await writeFile(dest, bytes);
    },
    run,
    now: () => new Date(options.now ?? "2026-10-23T12:00:00.000Z")
  };
  return host;
}
