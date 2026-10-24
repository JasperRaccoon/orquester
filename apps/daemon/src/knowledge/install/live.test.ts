import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { detectHostLibc } from "../../plugins/ts-rust/installer.ts";
import { MYKG_PROFILE, writeMykgConfig } from "../linking/mykg-config.ts";
import {
  MYKG_CONFIG_CHECK,
  defaultKnowledgeInstallerDeps,
  installKnowledgeRuntime,
  knowledgeHomeDir,
  knowledgeRuntimeOf,
  knowledgeRuntimeReady,
  mykgEnv,
  resolveMykgRelease,
  runCommand,
  sha256Hex
} from "./installer.ts";
import { overlayApplied, overlayDigest } from "./overlay.ts";
import { EMBEDDING_MODEL, MYKG_LINE, MYKG_PINNED_VERSION, TIKTOKEN_ENCODINGS, tiktokenCacheKey, uvBuildFor } from "./pins.ts";
import { tempRoot } from "./testing.ts";

// The real install, over the network, into a temp dir: uv from GitHub, CPython
// 3.12, myKG from PyPI with the shipped lock, the overlay, tiktoken's
// encodings, the config smoke test, the model from Hugging Face. Off unless ORQUESTER_KG_LIVE_INSTALL=1 (a few minutes and a
// few hundred MB). Keep the dir for a look with ORQUESTER_KG_LIVE_KEEP=1.

const live = process.env.ORQUESTER_KG_LIVE_INSTALL === "1";
const exec = promisify(execFile);

test("live: the pinned runtime installs, relocates and runs", { skip: !live, timeout: 30 * 60_000 }, async (t) => {
  const uv = uvBuildFor(process.platform, process.arch, process.platform === "linux" ? detectHostLibc() : "glibc");
  assert.ok(uv, `uv has no build for ${process.platform}/${process.arch}`);
  const root = await tempRoot("orq-kg-live-");
  if (process.env.ORQUESTER_KG_LIVE_KEEP !== "1") t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");
  // Where uv would write under the daemon user's HOME without the runtime's own env.
  const home = process.env.HOME ?? "/nonexistent";
  const homeDirs = [home, join(home, ".local", "bin"), join(home, ".local", "share", "uv", "python"), join(home, ".config", "uv")];
  const snapshot = async () =>
    Promise.all(homeDirs.map((dir) => readdir(dir).then((names) => names.sort(), () => [] as string[])));
  const homeBefore = await snapshot();

  const signal = new AbortController().signal;
  const release = await resolveMykgRelease(defaultKnowledgeInstallerDeps, signal, MYKG_PINNED_VERSION);
  const started = Date.now();
  const installed = await installKnowledgeRuntime(runtimeDir, release, defaultKnowledgeInstallerDeps, {
    uv,
    env: { PATH: process.env.PATH, ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}) },
    signal
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  assert.equal(installed.version, MYKG_PINNED_VERSION);
  assert.equal(await knowledgeRuntimeReady(runtimeDir, MYKG_PINNED_VERSION, { overlayDigestNow: await overlayDigest(MYKG_LINE) }), true);

  // From its final place (the venv was built in staging and renamed): it still runs.
  const runtime = knowledgeRuntimeOf(runtimeDir, MYKG_PINNED_VERSION);
  const venv = join(runtimeDir, "versions", MYKG_PINNED_VERSION, "venv");
  const env = mykgEnv(runtimeDir, venv, { PATH: process.env.PATH });
  const help = await runCommand(runtime.mykgBin, ["--help"], { cwd: root, env, timeoutMs: 60_000, signal });
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /extract-graph/);
  const py = await runCommand(
    runtime.pythonBin,
    ["-I", "-c", "import mykg.prompts as p, sys; print(sys.version.split()[0]); print(p.load_prompt('pass2/system').splitlines()[0])"],
    { cwd: root, env, timeoutMs: 60_000, signal }
  );
  assert.equal(py.exitCode, 0, py.stderr);
  assert.match(py.stdout, /^3\.12\./);
  const libDir = (await readdir(join(venv, "lib"))).find((name) => name.startsWith("python3."));
  assert.ok(libDir);
  assert.equal(await overlayApplied(MYKG_LINE, join(venv, "lib", libDir, "site-packages", "mykg", "prompts")), true);

  // tiktoken's encodings, and the config check again from the final place: the generated config
  // loads and the encoding comes from the runtime's cache with tiktoken's downloader disabled.
  for (const encoding of TIKTOKEN_ENCODINGS) {
    assert.equal(await sha256Hex(join(runtime.tiktokenCacheDir, tiktokenCacheKey(encoding.url))), encoding.sha256, encoding.name);
  }
  const mykgDir = join(root, "mykg");
  await mkdir(mykgDir);
  await writeMykgConfig(mykgDir, { concurrency: 4 });
  const check = await runCommand(
    runtime.pythonBin,
    ["-I", "-c", MYKG_CONFIG_CHECK, MYKG_PROFILE, join(mykgDir, "intermediate")],
    { cwd: mykgDir, env: { ...env, TIKTOKEN_CACHE_DIR: runtime.tiktokenCacheDir }, timeoutMs: 60_000, signal }
  );
  assert.equal(check.exitCode, 0, check.stderr);
  const report = JSON.parse(check.stdout.trim().split("\n").at(-1) ?? "");
  assert.deepEqual(
    { profile: report.profile, provider: report.provider, adapter: report.adapter, encoding: report.encoding },
    { profile: MYKG_PROFILE, provider: "agent", adapter: "AgentAdapter", encoding: "cl100k_base" }
  );
  t.diagnostic(`config check: ${check.stdout.trim()}`);

  for (const file of EMBEDDING_MODEL.files) {
    const path = join(runtime.embeddingModelDir, ...EMBEDDING_MODEL.id.split("/"), ...file.path.split("/"));
    assert.equal(await sha256Hex(path), file.sha256, file.path);
  }
  assert.ok((await stat(knowledgeHomeDir(runtimeDir))).isDirectory());
  const homeAfter = await snapshot();
  homeDirs.forEach((dir, index) => {
    const added = (homeAfter[index] ?? []).filter((name) => !(homeBefore[index] ?? []).includes(name));
    assert.ok(!added.some((name) => /python|uv|mykg/i.test(name)), `the install wrote ${added.join(", ")} into ${dir}`);
  });

  const sizes = await Promise.all(
    [runtimeDir, join(runtimeDir, "versions"), join(runtimeDir, "python"), runtime.embeddingModelDir].map(
      async (dir) => (await exec("du", ["-sh", dir])).stdout.trim()
    )
  );
  const du = sizes.join("\n");
  const manifest = JSON.parse(await readFile(join(runtimeDir, "versions", MYKG_PINNED_VERSION, "runtime.json"), "utf8"));
  t.diagnostic(`installed myKG ${installed.version} with uv ${manifest.uvVersion} in ${seconds}s; sizes:\n${du}`);
});
