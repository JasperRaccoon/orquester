import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { installBinary, rollbackBinary } from "./cliproxy-install.ts";
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
