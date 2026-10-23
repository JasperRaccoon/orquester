import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type MykgRelease,
  KnowledgeInstallError,
  MYKG_LOCKS_DIR,
  installKnowledgeRuntime,
  knowledgeHomeDir,
  knowledgePythonDir,
  knowledgeRuntimeOf,
  knowledgeRuntimeReady,
  knowledgeStagingDir,
  knowledgeVersionDir,
  parseLockVersions,
  pruneKnowledgeVersions,
  readKnowledgeManifest,
  resolveMykgRelease
} from "./installer.ts";
import { MYKG_PROMPTS_ROOT, overlayDigest, overlayFiles } from "./overlay.ts";
import { MYKG_LOCKS, MYKG_PINNED_VERSION, MYKG_PINNED_WHEEL_SHA256, UV_BUILDS, uvBuildFor } from "./pins.ts";
import { type FakeKnowledgeHost, fakeKnowledgeHost, makeModel, makeUvBuild, pypiWheel, sha256, tempRoot } from "./testing.ts";

// The runtime installer over a temp runtime dir, an in-memory network (uv's
// GitHub release, PyPI, the model files) and a fake uv/mykg runner
// (./testing.ts): staging, verification, the prompt overlay, the smoke test,
// the atomic rename, and that no child sees the daemon's env or HOME.

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
      installKnowledgeRuntime(runtimeDir, release, host.deps, { uv: uv.build, env: DAEMON_ENV, signal, model: model.spec })
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

  const manifest = await readKnowledgeManifest(versionDir);
  assert.equal(manifest?.mykgVersion, MYKG_PINNED_VERSION);
  assert.equal(manifest?.uvVersion, h.uv.build.version);
  assert.equal(manifest?.overlay.digest, await overlayDigest("0.4"));
  assert.deepEqual(manifest?.overlay.files, overlaid);
  assert.equal(manifest?.embeddingModel.revision, h.model.spec.revision);
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { model: h.model.spec }), true);

  // The steps, in order: python, venv, pip from the shipped lock with every hash, then the smoke test.
  const runs = h.host.calls.run;
  assert.deepEqual(
    runs.map((call) => [call.command.split("/").at(-1), call.args[0]]),
    [
      ["uv", "python"],
      ["uv", "venv"],
      ["uv", "pip"],
      ["mykg", "--help"]
    ]
  );
  assert.deepEqual(runs[0]?.args, ["python", "install", "3.12", "--no-bin"]);
  assert.ok(runs[1]?.args.includes("--relocatable"));
  const pip = runs[2]?.args ?? [];
  assert.deepEqual(pip.slice(pip.indexOf("--require-hashes")), ["--require-hashes", "-r", join(MYKG_LOCKS_DIR, "mykg-0.4.10.txt")]);

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

test("a newer patch installs its wheel by sha256, constrained to the pinned lock's versions", async (t) => {
  const h = await harness(t);
  let requirements = "";
  let constraints = "";
  const run = h.host.deps.run;
  h.host.deps.run = async (command, args, options) => {
    if (args[0] === "pip") {
      requirements = await readFile(args[args.indexOf("-r") + 1] ?? "", "utf8");
      constraints = await readFile(args[args.indexOf("-c") + 1] ?? "", "utf8");
      assert.ok(!args.includes("--require-hashes"));
    }
    return run(command, args, options);
  };
  const installed = await h.install({ version: "0.4.11", wheelSha256: NEWER_SHA });
  assert.equal(installed.version, "0.4.11");
  assert.equal(installed.integrity, `sha256:${NEWER_SHA}`);
  assert.equal(requirements, `mykg==0.4.11 --hash=sha256:${NEWER_SHA}\n`);
  assert.ok(!constraints.includes("mykg=="), "the pinned myKG is not a constraint");
  assert.ok(!constraints.includes("--hash"), "constraints carry versions only");
  assert.match(constraints, /^anthropic==0\.102\.0$/m);
  assert.deepEqual(await list(join(h.runtimeDir, "versions")), ["0.4.11"]);
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
  h.host.downloads.set(h.model.spec.fileUrl("onnx/model_quantized.onnx"), Buffer.from("other bytes"));
  await failsAt(h.install(), "model", /model_quantized\.onnx does not match its sha256/);
  h.host.downloads.delete(h.model.spec.fileUrl("config.json"));
  await failsAt(h.install(), "model", /HTTP 404/);

  assert.deepEqual(await readKnowledgeManifest(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION)), before);
  assert.deepEqual(await list(knowledgeStagingDir(h.runtimeDir)), []);
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

test("readiness: the manifest, the entry points, every model file, and (when asked) the shipped overlay", async (t) => {
  const h = await harness(t);
  const ready = (options: { overlayDigestNow?: string } = {}) =>
    knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION, { ...options, model: h.model.spec });
  assert.equal(await ready(), false, "nothing installed");
  await h.install();
  assert.equal(await ready({ overlayDigestNow: await overlayDigest("0.4") }), true);
  assert.equal(await ready({ overlayDigestNow: "f".repeat(64) }), false, "installed with another overlay");
  assert.equal(await knowledgeRuntimeReady(h.runtimeDir, MYKG_PINNED_VERSION), false, "another model pin");
  const runtime = knowledgeRuntimeOf(h.runtimeDir, MYKG_PINNED_VERSION, h.model.spec);
  await rm(join(runtime.embeddingModelDir, "Fixture", "mini-model", "config.json"));
  assert.equal(await ready(), false, "a model file is gone");
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
  assert.equal(uvBuildFor("darwin", "x64", "glibc")?.target, "x86_64-apple-darwin");
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
  assert.ok(lock.includes(`--hash=sha256:${MYKG_PINNED_WHEEL_SHA256}`));
  const versions = parseLockVersions(lock);
  assert.ok(versions.includes(`mykg==${MYKG_PINNED_VERSION}`));
  assert.ok(versions.length > 40);
  assert.ok(versions.every((line) => /^[A-Za-z0-9._-]+==\S+/.test(line)));
  assert.ok(versions.some((line) => line.startsWith("pywin32==312 ;")), "markers are kept");
  assert.deepEqual(parseLockVersions("# c\nfoo==1.0 \\\n    --hash=sha256:ab\nbar==2 ; x \\\n"), ["foo==1.0", "bar==2 ; x"]);
  assert.equal(sha256("x").length, 64);
});
