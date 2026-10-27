import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fakeRegistry, publish, tempRoot } from "../testing.ts";
import {
  type SmokeTestOptions,
  TSC_RS_ENGINE,
  TSRS_ENGINE,
  TsRustInstallError,
  detectHostLibc,
  installTsRustRelease,
  pruneTsRustVersions,
  resolveTsRustRelease,
  runVersionCommand,
  smokeTestEnv,
  tsRustBinaryPath,
  tsRustStagingDir,
  tsRustVersionsDir
} from "./installer.ts";

// The engine installer against an in-memory registry and tarballs built on the
// spot (../testing.ts): resolve, verify, extract, smoke-test, switch, prune.
// tsc-rs unless a test says otherwise.

const PKG = "@tsc-rs/linux-x64";
const TSRS_PKG = "@tsrs/linux-x64-gnu";
/** tsrs's version scheme: its own semver, then the TypeScript build it ports. */
const TSRS_VERSION = "0.16.0-ts7.1.0-dev.20260929";
const live = () => new AbortController().signal;

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await tempRoot("orq-ts-rust-installer-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginDir = join(root, "plugins", "ts-rust");
  const registry = fakeRegistry();
  return { root, pluginDir, registry };
}

async function install(pluginDir: string, registry: ReturnType<typeof fakeRegistry>, env: NodeJS.ProcessEnv = {}) {
  const engine = registry.engine;
  const release = await resolveTsRustRelease(engine, engine === TSRS_ENGINE ? TSRS_PKG : PKG, registry.deps, live());
  return installTsRustRelease(engine, pluginDir, release, registry.deps, { platform: "linux", env, signal: live() });
}

async function rejectsAt(promise: Promise<unknown>, step: string, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TsRustInstallError, `expected a TsRustInstallError, got ${String(error)}`);
    assert.equal(error.step, step);
    assert.match(error.message, message);
    return true;
  });
}

async function listing(dir: string): Promise<string[]> {
  return readdir(dir).then(
    (names) => names.sort(),
    () => []
  );
}

test("tsc-rs platform packages: linux, darwin and win32 on x64 and arm64; nothing else", () => {
  const pkg = (platform: string, arch: string) => TSC_RS_ENGINE.platformPackage(platform, arch, "glibc");
  assert.equal(pkg("linux", "x64"), "@tsc-rs/linux-x64");
  assert.equal(TSC_RS_ENGINE.platformPackage("linux", "x64", "musl"), "@tsc-rs/linux-x64");
  assert.equal(pkg("linux", "arm64"), "@tsc-rs/linux-arm64");
  assert.equal(pkg("darwin", "arm64"), "@tsc-rs/darwin-arm64");
  assert.equal(pkg("darwin", "x64"), "@tsc-rs/darwin-x64");
  assert.equal(pkg("win32", "x64"), "@tsc-rs/win32-x64");
  assert.equal(pkg("win32", "arm64"), "@tsc-rs/win32-arm64");
  assert.equal(pkg("freebsd", "x64"), null);
  assert.equal(pkg("linux", "ia32"), null);
  assert.equal(pkg("linux", "riscv64"), null);
  assert.equal(TSC_RS_ENGINE.binaryName("win32"), "tsc.exe");
  assert.equal(TSC_RS_ENGINE.binaryName("linux"), "tsc");
  assert.equal(tsRustBinaryPath(TSC_RS_ENGINE, "/p", "0.7.0", "win32"), join("/p", "versions", "0.7.0", "tsc.exe"));
});

test("tsrs platform packages: linux by libc on x64 and arm64, and Apple Silicon; no Windows, no Intel Mac", () => {
  assert.equal(TSRS_ENGINE.platformPackage("linux", "x64", "glibc"), "@tsrs/linux-x64-gnu");
  assert.equal(TSRS_ENGINE.platformPackage("linux", "x64", "musl"), "@tsrs/linux-x64-musl");
  assert.equal(TSRS_ENGINE.platformPackage("linux", "arm64", "glibc"), "@tsrs/linux-arm64-gnu");
  assert.equal(TSRS_ENGINE.platformPackage("linux", "arm64", "musl"), "@tsrs/linux-arm64-musl");
  assert.equal(TSRS_ENGINE.platformPackage("darwin", "arm64", "glibc"), "@tsrs/darwin-arm64");
  assert.equal(TSRS_ENGINE.platformPackage("darwin", "x64", "glibc"), null);
  assert.equal(TSRS_ENGINE.platformPackage("win32", "x64", "glibc"), null);
  assert.equal(TSRS_ENGINE.platformPackage("win32", "arm64", "glibc"), null);
  assert.equal(TSRS_ENGINE.platformPackage("linux", "ia32", "glibc"), null);
  assert.equal(TSRS_ENGINE.platformPackage("freebsd", "x64", "glibc"), null);
  assert.equal(TSRS_ENGINE.binaryName("linux"), "tsrs");
  assert.equal(tsRustBinaryPath(TSRS_ENGINE, "/p/tsrs", TSRS_VERSION, "linux"), join("/p/tsrs", "versions", TSRS_VERSION, "tsrs"));
  // The host's own C library reads as one of the two (this test host's Node reports it).
  assert.ok(["glibc", "musl"].includes(detectHostLibc()));
});


test("a registry answer that is not a plain version, or has no sha512, is refused at the registry step", async (t) => {
  const { registry } = await setup(t);
  registry.latest = "../../evil";
  await rejectsAt(resolveTsRustRelease(TSC_RS_ENGINE, PKG, registry.deps, live()), "registry", /no valid tsc-rs version/);

  const sha1Only = {
    ...registry.deps,
    fetchJson: async (url: string) =>
      url.endsWith("/latest")
        ? { version: "0.7.0" }
        : { version: "0.7.0", dist: { tarball: "https://registry.npmjs.org/x.tgz", integrity: "sha1-abc=" } }
  };
  await rejectsAt(resolveTsRustRelease(TSC_RS_ENGINE, PKG, sha1Only, live()), "registry", /no sha512 integrity/);

  const plainHttp = {
    ...registry.deps,
    fetchJson: async (url: string) =>
      url.endsWith("/latest")
        ? { version: "0.7.0" }
        : { version: "0.7.0", dist: { tarball: "http://registry.npmjs.org/x.tgz", integrity: "sha512-abc=" } }
  };
  await rejectsAt(resolveTsRustRelease(TSC_RS_ENGINE, PKG, plainHttp, live()), "registry", /no https tarball/);

  registry.failWith = "getaddrinfo ENOTFOUND registry.npmjs.org";
  await rejectsAt(resolveTsRustRelease(TSC_RS_ENGINE, PKG, registry.deps, live()), "registry", /ENOTFOUND/);
});

test("an install puts the whole lib dir at versions/<version>, the binary executable, and leaves no staging", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0");
  registry.latest = "0.7.0";

  const installed = await install(pluginDir, registry);
  assert.deepEqual(installed, {
    version: "0.7.0",
    integrity: registry.releases.get("0.7.0")?.integrity,
    installedAt: "2026-10-14T12:00:00.000Z"
  });
  const binary = tsRustBinaryPath(TSC_RS_ENGINE, pluginDir, "0.7.0", "linux");
  assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(tsRustVersionsDir(pluginDir), "0.7.0", "lib.d.ts"), "utf8"), "// lib for 0.7.0\n");
  assert.deepEqual(await listing(tsRustStagingDir(pluginDir)), []);
});


test("tsrs: an install puts the whole package at versions/<version>, the binary beside its lib .d.ts files", async (t) => {
  const { root } = await setup(t);
  const engineDir = join(root, "plugins", "ts-rust", "tsrs");
  const registry = fakeRegistry(undefined, TSRS_ENGINE);
  await publish(registry, root, TSRS_VERSION);
  registry.latest = TSRS_VERSION;
  const smoked: string[] = [];
  const smoke = registry.deps.runSmokeTest;
  registry.deps.runSmokeTest = (binary, options) => {
    smoked.push(binary);
    return smoke(binary, options);
  };

  const installed = await install(engineDir, registry);
  assert.deepEqual(installed, {
    version: TSRS_VERSION,
    integrity: registry.releases.get(TSRS_VERSION)?.integrity,
    installedAt: "2026-10-14T12:00:00.000Z"
  });
  const dir = join(tsRustVersionsDir(engineDir), TSRS_VERSION);
  assert.deepEqual(await listing(dir), ["LICENSE", "lib.d.ts", "package.json", "tsrs"]);
  const binary = tsRustBinaryPath(TSRS_ENGINE, engineDir, TSRS_VERSION, "linux");
  assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(dir, "lib.d.ts"), "utf8"), `// lib for ${TSRS_VERSION}\n`);
  assert.equal(smoked.length, 1, "the binary was smoke-tested before the switch");
  assert.deepEqual(await listing(tsRustStagingDir(engineDir)), []);
});


test("bad integrity stops before extracting: versions/ untouched, staging removed", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0");
  await publish(registry, root, "0.8.0", { claimedIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
  registry.latest = "0.7.0";
  await install(pluginDir, registry);

  registry.latest = "0.8.0";
  await rejectsAt(install(pluginDir, registry), "integrity", /does not match/);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), ["0.7.0"]);
  assert.deepEqual(await listing(tsRustStagingDir(pluginDir)), []);
});

test("a failing download is reported at the download step", async (t) => {
  const { pluginDir, registry } = await setup(t);
  const release = { version: "0.7.0", tarball: "https://registry.npmjs.org/gone.tgz", integrity: "sha512-AAAA" };
  await rejectsAt(
    installTsRustRelease(TSC_RS_ENGINE, pluginDir, release, registry.deps, { platform: "linux", env: {}, signal: live() }),
    "download",
    /HTTP 404/
  );
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), []);
  assert.deepEqual(await listing(tsRustStagingDir(pluginDir)), []);
});

test("a package without lib/tsc fails at the extract step", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0", { noBinary: true });
  registry.latest = "0.7.0";
  await rejectsAt(install(pluginDir, registry), "extract", /no lib\/tsc/);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), []);
});

test("the smoke test must exit 0 and print a Version line", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0", { script: "#!/bin/sh\necho 'Version 7.1.0-dev'\nexit 3\n" });
  await publish(registry, root, "0.8.0", { script: "#!/bin/sh\necho 'tsc 5.9.3'\n" });

  registry.latest = "0.7.0";
  await rejectsAt(install(pluginDir, registry), "smoke-test", /exited with code 3/);
  registry.latest = "0.8.0";
  await rejectsAt(install(pluginDir, registry), "smoke-test", /no version line/);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), []);
  assert.deepEqual(await listing(tsRustStagingDir(pluginDir)), []);
});

test("the smoke test runs with the daemon env minus ORQUESTER_* and a bounded timeout", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0");
  registry.latest = "0.7.0";
  const seen: SmokeTestOptions[] = [];
  registry.deps.runSmokeTest = async (_binary, options) => {
    seen.push(options);
    return { exitCode: null, stdout: "", timedOut: true };
  };

  await rejectsAt(
    install(pluginDir, registry, { PATH: "/usr/bin", ORQUESTER_APPDIR: "/srv/orq", ORQUESTER_HTTP_PASSWORD: "x" }),
    "smoke-test",
    /did not finish within 30s/
  );
  assert.deepEqual(seen[0]?.env, { PATH: "/usr/bin" });
  assert.equal(seen[0]?.timeoutMs, 30_000);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), []);
  assert.deepEqual(smokeTestEnv({ A: "1", ORQUESTER_X: "2", orquester_y: "3" }), { A: "1", orquester_y: "3" });
});

test("a leftover dir of the same version is replaced, other versions stay", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0");
  const stale = join(tsRustVersionsDir(pluginDir), "0.7.0");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "stale.txt"), "old");
  await mkdir(join(tsRustVersionsDir(pluginDir), "0.6.0"), { recursive: true });
  registry.latest = "0.7.0";

  await install(pluginDir, registry);
  assert.deepEqual(await listing(stale), ["lib.d.ts", "tsc"]);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), ["0.6.0", "0.7.0"]);
});

test("pruning keeps only the named versions", async (t) => {
  const { pluginDir } = await setup(t);
  for (const version of ["0.6.0", "0.7.0", "0.8.0"]) {
    await mkdir(join(tsRustVersionsDir(pluginDir), version), { recursive: true });
  }
  await pruneTsRustVersions(pluginDir, ["0.8.0", "0.7.0"]);
  assert.deepEqual(await listing(tsRustVersionsDir(pluginDir)), ["0.7.0", "0.8.0"]);
  // No versions dir at all is fine.
  await pruneTsRustVersions(join(pluginDir, "missing"), []);
});

test("a cancelled install reports cancelled and leaves nothing behind", async (t) => {
  const { root, pluginDir, registry } = await setup(t);
  await publish(registry, root, "0.7.0");
  registry.latest = "0.7.0";
  const release = await resolveTsRustRelease(TSC_RS_ENGINE, PKG, registry.deps, live());
  const abort = new AbortController();
  registry.deps.fetchTarball = async () => {
    abort.abort();
    throw new Error("aborted");
  };
  await rejectsAt(
    installTsRustRelease(TSC_RS_ENGINE, pluginDir, release, registry.deps, { platform: "linux", env: {}, signal: abort.signal }),
    "download",
    /^cancelled$/
  );
  assert.deepEqual(await listing(tsRustStagingDir(pluginDir)), []);
});

test("runVersionCommand: output and exit code, and a binary that cannot start", async (t) => {
  const root = await tempRoot("orq-ts-rust-run-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "tsc");
  await writeFile(script, "#!/bin/sh\necho \"Version 7.1.0-dev $FOO\"\nexit 0\n");
  await chmod(script, 0o755);
  const options = { cwd: root, env: { FOO: "bar", PATH: process.env.PATH }, timeoutMs: 30_000, signal: live() };

  assert.deepEqual(await runVersionCommand(script, options), {
    exitCode: 0,
    stdout: "Version 7.1.0-dev bar\n",
    timedOut: false
  });
  const failing = join(root, "failing");
  await writeFile(failing, "#!/bin/sh\nexit 2\n");
  await chmod(failing, 0o755);
  assert.deepEqual(await runVersionCommand(failing, options), { exitCode: 2, stdout: "", timedOut: false });
  const missing = await runVersionCommand(join(root, "missing"), options);
  assert.equal(missing.spawnError, "ENOENT");
});
