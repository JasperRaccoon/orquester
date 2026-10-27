import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { MYKG_CONFIG_FILE, MYKG_PROFILE, MYKG_TIKTOKEN_ENCODING, buildMykgConfig } from "../linking/mykg-config.ts";
import {
  type MykgRelease,
  KnowledgeInstallError,
  MYKG_CONFIG_CHECK,
  MYKG_LOCKS_DIR,
  installKnowledgeModel,
  installKnowledgeRuntime,
  knowledgeHomeDir,
  knowledgeModelReady,
  knowledgeModelRepairable,
  knowledgeMykgReady,
  knowledgePythonDir,
  knowledgeRuntimeOf,
  knowledgeRuntimeReady,
  knowledgeStagingDir,
  knowledgeVersionDir,
  pruneKnowledgeVersions,
  readKnowledgeManifest,
  resolveMykgRelease
} from "./installer.ts";
import { MYKG_PROMPTS_ROOT, overlayDigest, overlayFiles } from "./overlay.ts";
import {
  EMBEDDING_MODEL,
  MYKG_LOCKS,
  MYKG_PINNED_VERSION,
  MYKG_PINNED_WHEEL_SHA256,
  TIKTOKEN_ENCODINGS,
  UV_BUILDS,
  tiktokenCacheKey,
  uvBuildFor
} from "./pins.ts";
import { type FakeKnowledgeHost, fakeKnowledgeHost, makeModel, makeUvBuild, pypiWheel, sha256, tempRoot } from "./testing.ts";

// The runtime installer over a temp runtime dir, an in-memory network (uv's
// GitHub release, PyPI, the model files) and a fake uv/mykg runner
// (./testing.ts): staging, verification, the prompt overlay, tiktoken's
// encodings, the smoke test (with the generated config), the atomic rename, and that no child sees the daemon's env or HOME.

const PINNED: MykgRelease = { version: MYKG_PINNED_VERSION, wheelSha256: MYKG_PINNED_WHEEL_SHA256 };
const NEWER_SHA = "a".repeat(64);
const DAEMON_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/daemon-user",
  ORQUESTER_HTTP_PASSWORD: "hunter2",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  HTTPS_PROXY: "http://proxy.invalid:3128"
};

interface Harness {
  root: string;
  runtimeDir: string;
  host: FakeKnowledgeHost;
  uv: Awaited<ReturnType<typeof makeUvBuild>>;
  model: ReturnType<typeof makeModel>;
  install: (release?: MykgRelease, signal?: AbortSignal) => ReturnType<typeof installKnowledgeRuntime>;
}

async function harness(t: TestContext): Promise<Harness> {
  const root = await tempRoot("orq-kg-installer-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "appdir", "daemon", "plugins", "knowledge-graph", "runtime");
  const uv = await makeUvBuild(root);
  const model = makeModel();
  const host = fakeKnowledgeHost({ uv, model });
  return {
    root,
    runtimeDir,
    host,
    uv,
    model,
    install: (release = PINNED, signal = new AbortController().signal) =>
      installKnowledgeRuntime(runtimeDir, release, host.deps, {
        uv: uv.build,
        env: DAEMON_ENV,
        signal,
        model: model.spec,
        encodings: host.encodings
      })
  };
}

async function failsAt(promise: Promise<unknown>, step: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KnowledgeInstallError, `expected a KnowledgeInstallError, got ${String(error)}`);
    assert.equal(error.step, step);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/** `name==version[ ; marker]` of every requirement in a hashed lock (hashes and comments dropped). */
function parseLockVersions(lock: string): string[] {
  const out: string[] = [];
  for (const raw of lock.split(/\r?\n/)) {
    if (raw.startsWith(" ") || raw.startsWith("\t") || raw.startsWith("#")) continue;
    const line = raw.replace(/\\\s*$/, "").trim();
    if (/^[A-Za-z0-9._-]+==[^\s;]+/.test(line)) out.push(line);
  }
  return out;
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).then(
    (names) => names.sort(),
    () => []
  );
}

const promptsOf = (runtimeDir: string, version: string) =>
  join(knowledgeVersionDir(runtimeDir, version), "venv", "lib", "python3.12", "site-packages", "mykg", "prompts");

test("the pinned release installs from the hashed lock into versions/<v>/ with the overlay, the model and a manifest", async (t) => {
  const h = await harness(t);
  const installed = await h.install();
  assert.deepEqual(installed, {
    version: MYKG_PINNED_VERSION,
    integrity: `sha256:${MYKG_PINNED_WHEEL_SHA256}`,
    installedAt: "2026-10-23T12:00:00.000Z"
  });

  const runtime = knowledgeRuntimeOf(h.runtimeDir, MYKG_PINNED_VERSION, h.model.spec);
  const versionDir = knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION);
  assert.equal(runtime.mykgBin, join(versionDir, "venv", "bin", "mykg"));
  assert.equal(runtime.embeddingModelDir, join(versionDir, "models"));
  assert.equal(runtime.embeddingDimensions, 384);
  // The model sits where a transformers.js localModelPath expects it.
  for (const [path, bytes] of h.model.files) {
    assert.deepEqual(await readFile(join(runtime.embeddingModelDir, "Fixture", "mini-model", ...path.split("/"))), bytes);
  }
  // Every overlay file replaced the package's; the others are untouched.
  const prompts = promptsOf(h.runtimeDir, MYKG_PINNED_VERSION);
  const overlaid = await overlayFiles("0.4");
  for (const file of overlaid) {
    assert.deepEqual(await readFile(join(prompts, file)), await readFile(join(MYKG_PROMPTS_ROOT, "0.4", file)), file);
  }
  assert.equal(await readFile(join(prompts, "feedback", "user_template.txt"), "utf8"), "UPSTREAM feedback/user_template.txt\n");
  // tiktoken's encodings sit in the runtime's cache under tiktoken's own names.
  assert.equal(runtime.tiktokenCacheDir, join(versionDir, "tiktoken"));
  const [encoding] = h.host.encodings;
  assert.ok(encoding);
  assert.deepEqual(await list(runtime.tiktokenCacheDir), [tiktokenCacheKey(encoding.url)]);
  assert.equal(sha256(await readFile(join(runtime.tiktokenCacheDir, tiktokenCacheKey(encoding.url)))), encoding.sha256);

  const manifest = await readKnowledgeManifest(versionDir);
  assert.equal(manifest?.mykgVersion, MYKG_PINNED_VERSION);
  assert.equal(manifest?.uvVersion, h.uv.build.version);
  assert.equal(manifest?.overlay.digest, await overlayDigest("0.4"));
  assert.deepEqual(manifest?.overlay.files, overlaid);
  assert.equal(manifest?.embeddingModel.revision, h.model.spec.revision);
  assert.deepEqual(manifest?.tiktokenEncodings, ["cl100k_base"]);
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { model: h.model.spec }), true);

  // The steps, in order: python, venv, pip from the shipped lock with every hash, then the smoke
  // test: `mykg --help` and the config check.
  const runs = h.host.calls.run;
  assert.deepEqual(
    runs.map((call) => [call.command.split("/").at(-1), call.args[0]]),
    [
      ["uv", "python"],
      ["uv", "venv"],
      ["uv", "pip"],
      ["mykg", "--help"],
      ["python", "-I"]
    ]
  );
  // The config check: the venv's python, isolated, on linking's generated config in a dir of its
  // own, the profile it must select, and the staged tiktoken cache (which became versions/<v>/tiktoken).
  const check = runs[4];
  assert.ok(check);
  assert.deepEqual(check.args.slice(0, 4), ["-I", "-c", MYKG_CONFIG_CHECK, MYKG_PROFILE]);
  assert.ok(check.cwd.startsWith(knowledgeStagingDir(h.runtimeDir)));
  assert.equal(check.args[4], join(check.cwd, "intermediate"));
  assert.match(String(check.env.TIKTOKEN_CACHE_DIR), /\/runtime\/tiktoken$/);
  assert.equal(runs[3]?.env.TIKTOKEN_CACHE_DIR, check.env.TIKTOKEN_CACHE_DIR);
  assert.deepEqual(runs[0]?.args, ["python", "install", "3.12", "--no-bin"]);
  assert.ok(runs[1]?.args.includes("--relocatable"));
  const pip = runs[2]?.args ?? [];
  assert.deepEqual(pip.slice(pip.indexOf("--no-build")), ["--no-build", "--require-hashes", "-r", join(MYKG_LOCKS_DIR, "mykg-0.4.10.txt")]);

  // Nothing of the daemon's env but PATH and proxy settings; HOME and every uv dir inside the runtime dir.
  for (const call of runs) {
    for (const value of [...call.args, ...Object.values(call.env)]) {
      assert.ok(!String(value).includes("hunter2") && !String(value).includes("sk-ant"), `${call.args[0]} leaks a secret`);
    }
    assert.equal(call.env.ORQUESTER_HTTP_PASSWORD, undefined);
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.env.HOME, knowledgeHomeDir(h.runtimeDir));
    assert.equal(call.env.HTTPS_PROXY, DAEMON_ENV.HTTPS_PROXY);
  }
  const uvEnv = runs[0]?.env ?? {};
  assert.equal(uvEnv.UV_PYTHON_INSTALL_DIR, knowledgePythonDir(h.runtimeDir));
  for (const key of ["UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_BIN_DIR", "XDG_CONFIG_HOME", "TMPDIR"]) {
    assert.ok(String(uvEnv[key]).startsWith(h.runtimeDir), `${key} stays inside the runtime dir`);
  }
  assert.equal(uvEnv.UV_NO_CONFIG, "1");
  assert.equal(uvEnv.UV_PYTHON_PREFERENCE, "only-managed");

  // The pinned release needed no PyPI lookup; the staging dir is empty again.
  assert.deepEqual(h.host.calls.json, []);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), [MYKG_PINNED_VERSION]);
});

test("a newer patch installs its wheel by sha256; every other package by the pinned lock's hashes", async (t) => {
  const h = await harness(t);
  let requirements = "";
  let constraints = "";
  let pip: string[] = [];
  const run = h.host.deps.run;
  h.host.deps.run = async (command, args, options) => {
    if (args[0] === "pip") {
      pip = [...args];
      requirements = await readFile(args[args.indexOf("-r") + 1] ?? "", "utf8");
      constraints = await readFile(args[args.indexOf("-c") + 1] ?? "", "utf8");
    }
    return run(command, args, options);
  };
  const installed = await h.install({ version: "0.4.11", wheelSha256: NEWER_SHA });
  assert.equal(installed.version, "0.4.11");
  assert.equal(installed.integrity, `sha256:${NEWER_SHA}`);
  // uv takes hashes from constraints; --require-hashes refuses any package without one (a
  // dependency the patch added), --no-build any sdist build (its build deps carry no hash).
  assert.ok(pip.includes("--require-hashes"), "every package is hash-checked");
  assert.ok(pip.includes("--no-build"), "nothing is built from source");
  assert.equal(requirements, `mykg==0.4.11 --hash=sha256:${NEWER_SHA}\n`);
  assert.ok(!constraints.includes("mykg=="), "the pinned myKG is not a constraint");
  assert.ok(!constraints.includes(MYKG_PINNED_WHEEL_SHA256), "nor its hashes");
  const lock = await readFile(join(MYKG_LOCKS_DIR, MYKG_LOCKS[MYKG_PINNED_VERSION] ?? ""), "utf8");
  const block = (text: string, name: string) => new RegExp(`^${name}==[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m").exec(text)?.[0];
  for (const name of ["anthropic", "cryptography", "pywin32", "uv"]) {
    const want = block(lock, name);
    assert.ok(want?.includes("--hash=sha256:"), `${name} is hashed in the lock`);
    assert.equal(block(constraints, name), want, `${name} keeps its version, marker and hashes`);
  }
  assert.deepEqual(
    parseLockVersions(constraints),
    parseLockVersions(lock).filter((line) => !line.startsWith("mykg==")),
    "every other locked package is a constraint"
  );
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), ["0.4.11"]);
});

test("tar unpacks uv with the runtime's env too, not the daemon's", async (t) => {
  const h = await harness(t);
  // A `tar` first on the daemon's PATH that records its env, then runs the real one.
  const bin = join(h.root, "bin");
  const seen = join(h.root, "tar-env.txt");
  const realTar = (await promisify(execFile)("sh", ["-c", "command -v tar"])).stdout.trim();
  await mkdir(bin);
  await writeFile(join(bin, "tar"), `#!/bin/sh\nenv > '${seen}'\nexec '${realTar}' "$@"\n`, { mode: 0o755 });
  await installKnowledgeRuntime(h.runtimeDir, PINNED, h.host.deps, {
    uv: h.uv.build,
    env: { ...DAEMON_ENV, PATH: `${bin}:/usr/bin:/bin` },
    signal: new AbortController().signal,
    model: h.model.spec,
    encodings: h.host.encodings
  });
  const env = await readFile(seen, "utf8").catch(() => "");
  assert.match(env, new RegExp(`^HOME=${knowledgeHomeDir(h.runtimeDir)}$`, "m"), "tar ran with the runtime's HOME");
  assert.ok(!env.includes("hunter2") && !env.includes("sk-ant"), "tar saw a daemon secret");
});

test("uv must match both Orquester's pin and the release's published sha256", async (t) => {
  const h = await harness(t);
  h.host.texts.set(h.uv.build.sha256Url, `${"0".repeat(64)}  uv.tar.gz\n`);
  await failsAt(h.install(), "integrity", /published sha256/);

  h.host.texts.set(h.uv.build.sha256Url, `${h.uv.build.sha256}  uv.tar.gz\n`);
  h.host.downloads.set(h.uv.build.url, Buffer.from("tampered"));
  await failsAt(h.install(), "integrity", /does not match its sha256/);
  assert.deepEqual(h.host.calls.run, [], "nothing ran");
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), []);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
});

test("a myKG that renamed a prompt fails the install at the overlay, before anything is copied", async (t) => {
  const h = await harness(t);
  h.host.omitPrompts.add("pass2/system.txt");
  await failsAt(h.install(), "overlay", /no prompts\/pass2\/system\.txt/);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), []);
  assert.ok(!h.host.calls.run.some((call) => call.args[0] === "--help"), "no smoke test after a failed overlay");
});

test("each failing step is named and leaves versions/ as it was", async (t) => {
  const h = await harness(t);
  await h.install();
  const before = await readKnowledgeManifest(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION));

  h.host.failUv.set("python", "no download for cpython-3.12");
  await failsAt(h.install(), "python", /uv python exited with code 2: error: no download/);
  h.host.failUv.set("pip", "hash mismatch for anthropic");
  await failsAt(h.install(), "packages", /hash mismatch/);
  h.host.smoke = { exitCode: 1, stdout: "", stderr: "ImportError: no module named mcp\n", timedOut: false };
  await failsAt(h.install(), "smoke-test", /mykg --help exited with code 1: ImportError/);
  h.host.smoke = { exitCode: 0, stdout: "Usage: mykg\n", stderr: "", timedOut: false };
  await failsAt(h.install(), "smoke-test", /no extract-graph/);
  h.host.smoke = { exitCode: 0, stdout: "extract-graph\n", stderr: "", timedOut: false };
  const encodingUrl = h.host.encodings[0]?.url ?? "";
  const encodingBytes = h.host.downloads.get(encodingUrl) ?? Buffer.alloc(0);
  h.host.downloads.set(encodingUrl, Buffer.from("tampered"));
  await failsAt(h.install(), "tiktoken", /cl100k_base encoding does not match its sha256/);
  h.host.downloads.set(encodingUrl, encodingBytes);
  h.host.downloads.set(h.model.spec.fileUrl("onnx/model_quantized.onnx"), Buffer.from("other bytes"));
  await failsAt(h.install(), "model", /model_quantized\.onnx does not match its sha256/);
  h.host.downloads.delete(h.model.spec.fileUrl("config.json"));
  await failsAt(h.install(), "model", /HTTP 404/);

  assert.deepEqual(await readKnowledgeManifest(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION)), before);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
});

test("a myKG that rejects the generated config fails the install at the smoke test, naming why", async (t) => {
  const h = await harness(t);
  h.host.configCheck = {
    exitCode: 1,
    stdout: "",
    stderr: 'Traceback (most recent call last):\n  File "<string>", line 9, in <module>\nKeyError: \'per_file_token_target\'\n',
    timedOut: false
  };
  await failsAt(
    h.install({ version: "0.4.11", wheelSha256: NEWER_SHA }),
    "smoke-test",
    /^myKG 0\.4\.11 rejected the generated config \(profile agent-claude-code\): .*KeyError: 'per_file_token_target'$/
  );
  // Exit 0 without the report is no pass either.
  h.host.configCheck = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  await failsAt(h.install(), "smoke-test", /rejected the generated config/);
  h.host.configCheck = { exitCode: null, stdout: "", stderr: "", timedOut: true };
  await failsAt(h.install(), "smoke-test", /the config check did not finish/);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), []);
  assert.ok(!h.host.calls.downloads.some((url) => url.startsWith("https://hf.invalid/")), "no model download after a failed smoke test");
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
});

test("the config check refuses a tokenizer download before its downloader runs", async (t) => {
  const exec = promisify(execFile);
  // These dependency shims leave the downloader enabled. The shipped script must replace it.
  const dependencies = `
import sys, types

def module(name):
    value = types.ModuleType(name)
    sys.modules[name] = value
    return value

tiktoken = module("tiktoken")
tiktoken.load = module("tiktoken.load")
def download(path):
    print("DOWNLOADER_USED", flush=True)
    return b"downloaded"
tiktoken.load.read_file = download
class Encoding:
    name = "fixture"
    def encode(self, text):
        print("ENCODING_REQUESTED", flush=True)
        tiktoken.load.read_file("https://fixture.invalid/encoding")
tiktoken.get_encoding = lambda name: Encoding()
mykg = module("mykg")
mykg.config = module("mykg.config")
mykg.config.RAW = {"profile": "fixture", "provider": "agent"}
mykg.config.CONFIG_PATH = "mykg_config.yaml"
mykg.config.CHUNK_TIKTOKEN_ENCODING = "fixture"
module("mykg.pipeline")
module("mykg.llm")
module("mykg.llm.config").load_adapter = lambda **kwargs: object()
sys.argv = ["check", "fixture", "/unused"]
`;
  await assert.rejects(exec("python3", ["-I", "-c", `${dependencies}\nexec(${JSON.stringify(MYKG_CONFIG_CHECK)})`]), (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("python3 is not installed; the runtime ships its own Python");
      return true;
    }
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    assert.match(stdout, /ENCODING_REQUESTED/, "the check reached the tokenizer");
    assert.doesNotMatch(stdout, /DOWNLOADER_USED/, "the script must refuse before the network loader runs");
    assert.match(stderr, /https:\/\/fixture\.invalid\/encoding/, "the failure identifies the missing encoding");
    return true;
  });
});

test("the pinned encodings are the one the generated config loads, under tiktoken's cache names", () => {
  const profile = (buildMykgConfig({ concurrency: 4 }).profiles as Record<string, any>)[MYKG_PROFILE];
  assert.equal(profile.pipeline.chunking.tiktoken_encoding, MYKG_TIKTOKEN_ENCODING);
  assert.deepEqual(
    TIKTOKEN_ENCODINGS.map((encoding) => encoding.name),
    [MYKG_TIKTOKEN_ENCODING]
  );
  const [cl100k] = TIKTOKEN_ENCODINGS;
  // tiktoken 0.13.0: the URL and expected_hash in tiktoken_ext/openai_public.py; the cache key is sha1(url).
  assert.equal(cl100k?.url, "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken");
  assert.equal(cl100k?.sha256, "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7");
  assert.equal(tiktokenCacheKey(cl100k?.url ?? ""), "9b5ad71b2ce5302211f9c61530b329a4922fc6a4");
  assert.equal(MYKG_CONFIG_FILE, "mykg_config.yaml");
});

test("a leftover dir of the same version is replaced; a cancelled install leaves nothing", async (t) => {
  const h = await harness(t);
  const target = knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "stale"), "x");
  await h.install();
  assert.equal(await stat(join(target, "stale")).catch(() => null), null);
  assert.ok(await readKnowledgeManifest(target));

  const abort = new AbortController();
  h.host.onDownload = async (_url, signal) => {
    abort.abort();
    signal.throwIfAborted();
  };
  await failsAt(h.install({ version: "0.4.11", wheelSha256: NEWER_SHA }, abort.signal), "download", /cancelled/);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), [MYKG_PINNED_VERSION]);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
});

test("an invalid release is refused before anything is downloaded", async (t) => {
  const h = await harness(t);
  await failsAt(h.install({ version: "0.5.0", wheelSha256: NEWER_SHA }), "install", /invalid myKG version/);
  await failsAt(h.install({ version: "../0.4.11", wheelSha256: NEWER_SHA }), "install");
  await failsAt(h.install({ version: "0.4.11", wheelSha256: "nope" }), "install", /sha256/);
  assert.deepEqual(h.host.calls.downloads, []);
});

test("readiness: the manifest, the entry points, every model file, and (when asked) the shipped overlay and encodings", async (t) => {
  const h = await harness(t);
  const ready = (options: { overlayDigestNow?: string; encodings?: typeof h.host.encodings } = {}) =>
    knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { ...options, model: h.model.spec });
  assert.equal(await ready(), false, "nothing installed");
  await h.install();
  assert.equal(await ready({ overlayDigestNow: await overlayDigest("0.4") }), true);
  assert.equal(await ready({ overlayDigestNow: "f".repeat(64) }), false, "installed with another overlay");
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION), false, "another model pin");
  const runtime = knowledgeRuntimeOf(h.runtimeDir, MYKG_PINNED_VERSION, h.model.spec);
  assert.equal(await ready({ encodings: h.host.encodings }), true);
  await rm(join(runtime.tiktokenCacheDir, tiktokenCacheKey(h.host.encodings[0]?.url ?? "")));
  assert.equal(await ready({ encodings: h.host.encodings }), false, "an encoding is gone");
  assert.equal(await ready(), true, "it still runs without one (tiktoken would fetch it)");
  await rm(join(runtime.embeddingModelDir, "Fixture", "mini-model", "config.json"));
  assert.equal(await ready(), false, "a model file is gone");
});

/** `h` with the pinned version installed holding `old` (an install from before the model changed). */
async function installedWithOldModel(h: Harness): Promise<ReturnType<typeof makeModel>> {
  const old = makeModel({ id: "Xenova/all-MiniLM-L6-v2", tag: "-minilm" });
  for (const [path, bytes] of old.files) h.host.downloads.set(old.spec.fileUrl(path), bytes);
  await installKnowledgeRuntime(h.runtimeDir, PINNED, h.host.deps, {
    uv: h.uv.build,
    env: DAEMON_ENV,
    signal: new AbortController().signal,
    model: old.spec,
    encodings: h.host.encodings
  });
  return old;
}

test("readiness splits myKG from the model: another model's install runs but lacks this model", async (t) => {
  const h = await harness(t);
  await installedWithOldModel(h);
  const overlayDigestNow = await overlayDigest("0.4");
  assert.equal(await knowledgeMykgReady(h.runtimeDir, MYKG_PINNED_VERSION, { overlayDigestNow, encodings: h.host.encodings }), true);
  assert.equal(await knowledgeModelReady(h.runtimeDir, MYKG_PINNED_VERSION, h.model.spec), false);
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { model: h.model.spec }), false);
  // The pinned model: e5's prefixes, 512 tokens, thresholds ordered minimum < good < strong < duplicate.
  assert.equal(EMBEDDING_MODEL.id, "Xenova/multilingual-e5-small");
  assert.deepEqual([EMBEDDING_MODEL.queryPrefix, EMBEDDING_MODEL.passagePrefix, EMBEDDING_MODEL.maxTokens], ["query: ", "passage: ", 512]);
  const { minimum, good, strong, duplicate } = EMBEDDING_MODEL.thresholds;
  assert.ok(0 < minimum && minimum < good && good < strong && strong < duplicate && duplicate < 1);
  assert.ok(EMBEDDING_MODEL.files.some((file) => file.path === "onnx/model_quantized.onnx"));
  assert.equal(EMBEDDING_MODEL.fileUrl("config.json"), `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${EMBEDDING_MODEL.revision}/config.json`);
});

test("an install with another model is repaired with the model alone, the rest of the version untouched", async (t) => {
  const h = await harness(t);
  await installedWithOldModel(h);
  const versionDir = knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION);
  // A field a newer Orquester may have written survives the rewrite.
  const manifestPath = join(versionDir, "runtime.json");
  const written = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...written, futureField: { kept: true } }));
  const venvBefore = await stat(join(versionDir, "venv", "bin", "mykg"));
  const overlayDigestNow = await overlayDigest("0.4");
  const repairable = (release: MykgRelease = PINNED, encodings = h.host.encodings, digest = overlayDigestNow) =>
    knowledgeModelRepairable(h.runtimeDir, release, { overlayDigestNow: digest, model: h.model.spec, encodings });
  assert.equal(await repairable(), true);
  assert.equal(await repairable({ version: MYKG_PINNED_VERSION, wheelSha256: NEWER_SHA }), false, "another wheel: a full install");
  assert.equal(await repairable({ version: "0.4.11", wheelSha256: NEWER_SHA }), false, "not installed");
  assert.equal(await repairable(PINNED, h.host.encodings, "f".repeat(64)), false, "another overlay: a full install");

  const runs = h.host.calls.run.length;
  const downloads = h.host.calls.downloads.length;
  const installed = await installKnowledgeModel(h.runtimeDir, PINNED, h.host.deps, { signal: new AbortController().signal, model: h.model.spec });
  assert.deepEqual(installed, { version: MYKG_PINNED_VERSION, integrity: `sha256:${MYKG_PINNED_WHEEL_SHA256}`, installedAt: "2026-10-23T12:00:00.000Z" });
  // Only the model's files were fetched; no uv, no smoke test.
  assert.equal(h.host.calls.run.length, runs);
  assert.deepEqual(h.host.calls.downloads.slice(downloads), h.model.spec.files.map((file) => h.model.spec.fileUrl(file.path)));
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { overlayDigestNow, model: h.model.spec, encodings: h.host.encodings }), true);
  assert.equal(await repairable(), false, "nothing left to repair");
  // The old model is gone, the new one sits where the embedder looks.
  assert.deepEqual(await list(join(versionDir, "models")), ["Fixture"]);
  for (const [path, bytes] of h.model.files) {
    assert.deepEqual(await readFile(join(versionDir, "models", "Fixture", "mini-model", ...path.split("/"))), bytes);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.embeddingModel, {
    id: h.model.spec.id,
    revision: h.model.spec.revision,
    dimensions: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    maxTokens: 512
  });
  assert.deepEqual(manifest.futureField, { kept: true });
  assert.equal(manifest.installedAt, written.installedAt, "myKG's install time stays");
  assert.equal(manifest.overlay.digest, overlayDigestNow);
  assert.equal((await stat(join(versionDir, "venv", "bin", "mykg"))).mtimeMs, venvBefore.mtimeMs);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
});

test("a model download that does not match its hash is refused and leaves the version as it was", async (t) => {
  const h = await harness(t);
  const old = await installedWithOldModel(h);
  const versionDir = knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION);
  const before = await readFile(join(versionDir, "runtime.json"), "utf8");
  const install = () => installKnowledgeModel(h.runtimeDir, PINNED, h.host.deps, { signal: new AbortController().signal, model: h.model.spec });

  h.host.downloads.set(h.model.spec.fileUrl("onnx/model_quantized.onnx"), Buffer.from("tampered bytes"));
  await failsAt(install(), "model", /Fixture\/mini-model\/onnx\/model_quantized\.onnx does not match its sha256/);
  h.host.downloads.delete(h.model.spec.fileUrl("config.json"));
  await failsAt(install(), "model", /HTTP 404/);
  const abort = new AbortController();
  abort.abort();
  await failsAt(installKnowledgeModel(h.runtimeDir, PINNED, h.host.deps, { signal: abort.signal, model: h.model.spec }), "model", /cancelled/);

  assert.equal(await readFile(join(versionDir, "runtime.json"), "utf8"), before);
  for (const [path, bytes] of old.files) {
    assert.deepEqual(await readFile(join(versionDir, "models", "Xenova", "all-MiniLM-L6-v2", ...path.split("/"))), bytes);
  }
  assert.equal(await knowledgeMykgReady(h.runtimeDir, MYKG_PINNED_VERSION), true);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);

  // A version no longer installed from the same wheel is not touched.
  await rm(versionDir, { recursive: true });
  for (const [path, bytes] of h.model.files) h.host.downloads.set(h.model.spec.fileUrl(path), bytes);
  await failsAt(install(), "install", /not installed from the same wheel/);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), []);
});

test("prune keeps only the named versions", async (t) => {
  const h = await harness(t);
  for (const version of ["0.4.10", "0.4.11", "0.4.12"]) {
    await mkdir(knowledgeVersionDir(h.runtimeDir, version), { recursive: true });
  }
  await pruneKnowledgeVersions(h.runtimeDir, ["0.4.12", "0.4.11"]);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), ["0.4.11", "0.4.12"]);
  await pruneKnowledgeVersions(join(h.root, "nowhere"), []);
});

test("latest is the newest usable patch of the pinned minor line; the pin resolves offline", async (t) => {
  const h = await harness(t);
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveMykgRelease(h.host.deps, signal), PINNED);

  h.host.pypi.set("0.4.9", [pypiWheel("0.4.9", "9".repeat(64))]);
  h.host.pypi.set("0.4.11", [pypiWheel("0.4.11", "b".repeat(64))]);
  h.host.pypi.set("0.4.12", [pypiWheel("0.4.12", "c".repeat(64), { yanked: true })]);
  h.host.pypi.set("0.4.13", [{ filename: "mykg-0.4.13.tar.gz", packagetype: "sdist", digests: { sha256: "d".repeat(64) } }]);
  h.host.pypi.set("0.4.14rc1", [pypiWheel("0.4.14rc1", "e".repeat(64))]);
  h.host.pypi.set("0.5.0", [pypiWheel("0.5.0", "f".repeat(64))]);
  assert.deepEqual(await resolveMykgRelease(h.host.deps, signal), { version: "0.4.11", wheelSha256: "b".repeat(64) });

  h.host.calls.json.length = 0;
  assert.deepEqual(await resolveMykgRelease(h.host.deps, signal, MYKG_PINNED_VERSION), PINNED);
  assert.deepEqual(h.host.calls.json, [], "the pinned version needs no lookup");
  assert.deepEqual(await resolveMykgRelease(h.host.deps, signal, "0.4.11"), { version: "0.4.11", wheelSha256: "b".repeat(64) });
  await assert.rejects(resolveMykgRelease(h.host.deps, signal, "0.4.12"), /no usable wheel/);
  await assert.rejects(resolveMykgRelease(h.host.deps, signal, "0.5.0"), /not a 0\.4\.x release/);

  h.host.pypiDown = true;
  await assert.rejects(resolveMykgRelease(h.host.deps, signal), (error: unknown) => {
    assert.ok(error instanceof KnowledgeInstallError);
    assert.equal(error.step, "registry");
    return true;
  });
});

test("the uv pins: one build per supported host, none elsewhere", () => {
  assert.equal(uvBuildFor("linux", "x64", "glibc")?.target, "x86_64-unknown-linux-gnu");
  assert.equal(uvBuildFor("linux", "x64", "musl")?.target, "x86_64-unknown-linux-musl");
  assert.equal(uvBuildFor("linux", "arm64", "glibc")?.target, "aarch64-unknown-linux-gnu");
  assert.equal(uvBuildFor("linux", "arm64", "musl")?.target, "aarch64-unknown-linux-musl");
  // The pinned lock has no Intel-macOS wheel of cryptography 49 (and nothing is built from source).
  assert.equal(uvBuildFor("darwin", "x64", "glibc"), null);
  assert.equal(uvBuildFor("darwin", "arm64", "glibc")?.target, "aarch64-apple-darwin");
  assert.equal(uvBuildFor("win32", "x64", "glibc"), null);
  assert.equal(uvBuildFor("linux", "riscv64", "glibc"), null);
  assert.equal(uvBuildFor("freebsd", "x64", "glibc"), null);
  const build = uvBuildFor("linux", "x64", "glibc");
  assert.equal(build?.url, "https://github.com/astral-sh/uv/releases/download/0.13.4/uv-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(build?.sha256Url, `${build?.url}.sha256`);
  for (const pin of Object.values(UV_BUILDS)) assert.match(pin.sha256, /^[0-9a-f]{64}$/);
});

test("the shipped lock pins the pinned myKG by its wheel hash and every dependency by version", async () => {
  const lock = await readFile(join(MYKG_LOCKS_DIR, MYKG_LOCKS[MYKG_PINNED_VERSION] ?? ""), "utf8");
  const requirements = lock.replace(/^#.*$/gm, "").trim().split(/\n(?=\S)/);
  const mykg = requirements.find((block) => block.startsWith(`mykg==${MYKG_PINNED_VERSION} `));
  assert.ok(mykg?.includes(`--hash=sha256:${MYKG_PINNED_WHEEL_SHA256}`), "the pinned wheel is hashed in its requirement");
  for (const block of requirements) {
    assert.match(block.split("\n")[0]!, /^[A-Za-z0-9._-]+==[^\s;]+(?:\s*;.*)?\s*\\?$/, "every requirement is pinned");
    assert.match(block, /--hash=sha256:[0-9a-f]{64}\b/, "every requirement has an integrity hash");
  }
});
