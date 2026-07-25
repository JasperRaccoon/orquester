import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { installBinary, listPatches, rollbackBinary } from "./cliproxy-install.ts";
const exec = promisify(execFile);

async function makeFixtureTarball(dir: string, content: string) {
  const src = join(dir, "src");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "cli-proxy-api"), content, { mode: 0o755 });
  const tgz = join(dir, "fixture.tgz");
  await exec("tar", ["-czf", tgz, "-C", src, "cli-proxy-api"]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

async function makeNestedFixtureTarball(dir: string, content: string, subdir: string) {
  const src = join(dir, "src");
  await mkdir(join(src, subdir), { recursive: true });
  await writeFile(join(src, subdir, "cli-proxy-api"), content, { mode: 0o755 });
  const tgz = join(dir, "fixture.tgz");
  await exec("tar", ["-czf", tgz, "-C", src, subdir]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

async function makeAmbiguousFixtureTarball(dir: string, content: string) {
  const src = join(dir, "src");
  await mkdir(join(src, "a"), { recursive: true });
  await mkdir(join(src, "b"), { recursive: true });
  await writeFile(join(src, "a", "cli-proxy-api"), content, { mode: 0o755 });
  await writeFile(join(src, "b", "cli-proxy-api"), content, { mode: 0o755 });
  const tgz = join(dir, "fixture.tgz");
  await exec("tar", ["-czf", tgz, "-C", src, "a", "b"]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

async function makeMissingFixtureTarball(dir: string, content: string) {
  const src = join(dir, "src");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "other-binary"), content, { mode: 0o755 });
  const tgz = join(dir, "fixture.tgz");
  await exec("tar", ["-czf", tgz, "-C", src, "other-binary"]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

test("installBinary verifies sha256, installs 0755, keeps prior in bin.prev", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-"));
  try {
    const { tgz, sha } = await makeFixtureTarball(root, "#!/bin/sh\necho v1\n");
    const deps = { fetchTarball: async (_url: string, dest: string) => { await exec("cp", [tgz, dest]); } };
    const r = await installBinary(root, deps, sha);
    assert.equal(r.installed, true);
    const bin = join(root, "cliproxy", "bin", "cli-proxy-api");
    assert.equal((await stat(bin)).mode & 0o777, 0o755);
    // second install of a different binary moves the first to bin.prev
    const f2 = await makeFixtureTarball(join(root, "b"), "#!/bin/sh\necho v2\n");
    await installBinary(root, { fetchTarball: async (_u, d) => { await exec("cp", [f2.tgz, d]); } }, f2.sha);
    assert.match(await readFile(bin, "utf8"), /v2/);
    assert.equal(await rollbackBinary(root), true);
    assert.match(await readFile(bin, "utf8"), /v1/); // rolled back
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary rejects a sha256 mismatch and does not install", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-bad-"));
  try {
    const { tgz } = await makeFixtureTarball(root, "malicious");
    const deps = { fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); } };
    await assert.rejects(() => installBinary(root, deps, "0".repeat(64)), /sha256 mismatch/);
    await assert.rejects(stat(join(root, "cliproxy", "bin", "cli-proxy-api")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary extracts a nested cli-proxy-api entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-nested-"));
  try {
    const { tgz, sha } = await makeNestedFixtureTarball(root, "#!/bin/sh\necho nested\n", "CLIProxyAPI_7.2.95_linux_amd64");
    const deps = { fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); } };
    const r = await installBinary(root, deps, sha);
    assert.equal(r.installed, true);
    const bin = join(root, "cliproxy", "bin", "cli-proxy-api");
    assert.equal((await stat(bin)).mode & 0o777, 0o755);
    assert.match(await readFile(bin, "utf8"), /nested/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary rejects an ambiguous tarball with multiple cli-proxy-api entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-ambiguous-"));
  try {
    const { tgz, sha } = await makeAmbiguousFixtureTarball(root, "#!/bin/sh\necho x\n");
    const deps = { fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); } };
    await assert.rejects(() => installBinary(root, deps, sha), /matched multiple/);
    await assert.rejects(stat(join(root, "cliproxy", "bin", "cli-proxy-api")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary rejects a tarball missing the cli-proxy-api binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-missing-"));
  try {
    const { tgz, sha } = await makeMissingFixtureTarball(root, "#!/bin/sh\necho x\n");
    const deps = { fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); } };
    await assert.rejects(() => installBinary(root, deps, sha), /not found in release tarball/);
    await assert.rejects(stat(join(root, "cliproxy", "bin", "cli-proxy-api")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function makeSourceFixtureTarball(dir: string) {
  const pkg = join(dir, "srcpkg");
  const src = join(pkg, "CLIProxyAPI-7.2.95");
  await mkdir(join(src, "cmd", "server"), { recursive: true });
  await writeFile(join(src, "go.mod"), "module fixture\n");
  const tgz = join(dir, "source.tgz");
  await exec("tar", ["-czf", tgz, "-C", pkg, "CLIProxyAPI-7.2.95"]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

test("installBinary with patches builds from source: git apply then go build, promoted with rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-patched-"));
  try {
    // A prior stock binary must survive into bin.prev.
    await mkdir(join(root, "cliproxy", "bin"), { recursive: true });
    await writeFile(join(root, "cliproxy", "bin", "cli-proxy-api"), "stock", { mode: 0o755 });

    const { tgz, sha } = await makeSourceFixtureTarball(root);
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const deps = {
      fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); },
      run: async (cmd: string, args: string[], opts: { cwd?: string }) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        if (args[0] === "build") {
          const out = args[args.indexOf("-o") + 1];
          await writeFile(out, "patched", { mode: 0o755 });
        }
        return { stdout: "" };
      }
    };
    const patch = join(root, "0001-test.patch");
    const r = await installBinary(root, deps, undefined, { patches: [patch], sourceSha: sha });

    assert.equal(r.installed, true);
    assert.equal(r.version, "v7.2.95+orq1");
    assert.equal(await readFile(join(root, "cliproxy", "bin", "cli-proxy-api"), "utf8"), "patched");
    assert.equal(await readFile(join(root, "cliproxy", "bin.prev", "cli-proxy-api"), "utf8"), "stock");
    // Order + shape of toolchain calls: git apply inside the extracted source, then go build.
    assert.equal(calls[0].cmd, "git");
    assert.deepEqual(calls[0].args, ["apply", patch]);
    assert.ok(calls[0].cwd?.endsWith("CLIProxyAPI-7.2.95"), "git apply runs in the source dir");
    assert.equal(calls[1].args[0], "build");
    assert.equal(calls[1].args[calls[1].args.length - 1], "./cmd/server");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary with patches: source sha mismatch rejects before any toolchain call", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-patched-sha-"));
  try {
    const { tgz } = await makeSourceFixtureTarball(root);
    const calls: string[] = [];
    const deps = {
      fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); },
      run: async (cmd: string) => { calls.push(cmd); return { stdout: "" }; }
    };
    await assert.rejects(
      () => installBinary(root, deps, undefined, { patches: ["/x.patch"], sourceSha: "0".repeat(64) }),
      /source sha256 mismatch/
    );
    assert.equal(calls.length, 0, "no git/go runs on a bad source tarball");
    await assert.rejects(stat(join(root, "cliproxy", "bin", "cli-proxy-api")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("listPatches: sorted .patch files only, empty for missing dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-patchlist-"));
  try {
    await writeFile(join(root, "0002-b.patch"), "b");
    await writeFile(join(root, "0001-a.patch"), "a");
    await writeFile(join(root, "README.md"), "doc");
    assert.deepEqual(await listPatches(root), [join(root, "0001-a.patch"), join(root, "0002-b.patch")]);
    assert.deepEqual(await listPatches(join(root, "missing")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
