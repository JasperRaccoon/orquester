import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExecFn } from "../android/exec.ts";
import { downloadPinned, type DownloadFn } from "./download.ts";
import { BOX_TOOLS_LOCK, INSTALL_SENTINEL, installNpmTool, isToolInstalled, pruneToolVersions, toolDir, toolLock } from "./npm-tools.ts";
import { DEVICE_TOOL_VERSIONS } from "./index.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-npm-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `npm ci` that "installs" the lock's package entry module into the prefix; `fail` makes it exit 1. */
function fakeNpm(calls: string[][], options: { fail?: boolean } = {}): ExecFn {
  return async (_command, args) => {
    calls.push([...args]);
    if (options.fail) return { exitCode: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const pkg = JSON.parse(await readFile(join(prefix, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.ok(existsSync(join(prefix, "package-lock.json")), "the lockfile is in the prefix");
    const name = Object.keys(pkg.dependencies)[0]!;
    const entry = join(prefix, name === "agent-device" ? "node_modules/agent-device/bin/agent-device.mjs" : "node_modules/expo-device-hub/dist/server/cli.mjs");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// entry\n");
    return { exitCode: 0, stdout: "added 1 package", stderr: "" };
  };
}

const noDownload: DownloadFn = async () => { throw new Error("unexpected download while installing agent-device"); };

test("pinned downloads verify actual bytes, reuse verified cache and preserve prior files on checksum failure", async (t) => {
  await withDir(async (root) => {
    let calls = 0;
    let body = "hello";
    t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response(body); });
    const file = { url: "https://fixture.invalid/tool", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" };
    const dest = join(root, "tool");
    const signal = new AbortController().signal;
    await downloadPinned(file, dest, { signal });
    assert.equal(await readFile(dest, "utf8"), "hello");
    await downloadPinned(file, dest, { signal });
    assert.equal(calls, 1);
    body = "untrusted bytes";
    await assert.rejects(downloadPinned({ ...file, sha256: "0".repeat(64) }, dest, { signal }), /checksum/);
    assert.equal(calls, 2);
    assert.equal(await readFile(dest, "utf8"), "hello");
    assert.equal(existsSync(`${dest}.part`), false);
  });
});

test("install: a failed npm leaves nothing installed and no staging dir; the error names npm's last line", async () => {
  await withDir(async (root) => {
    const version = DEVICE_TOOL_VERSIONS["agent-device"];
    const deps = { exec: fakeNpm([], { fail: true }), download: noDownload, nodePath: "/n", npmCli: "/c", env: {}, downloads: join(root, ".dl") };
    await assert.rejects(installNpmTool(root, "agent-device", version, deps, new AbortController().signal), /404 Not Found/);
    assert.equal(isToolInstalled(root, "agent-device", version), false);
    assert.deepEqual((await readdir(root)).filter((entry) => !entry.startsWith(".agent-device.lock")), []);
  });
});

test("install: a dir without the sentinel is not installed and is replaced", async () => {
  await withDir(async (root) => {
    const version = DEVICE_TOOL_VERSIONS["agent-device"];
    const half = toolDir(root, "agent-device", version);
    await mkdir(join(half, "node_modules", "agent-device", "bin"), { recursive: true });
    await writeFile(join(half, "node_modules/agent-device/bin/agent-device.mjs"), "");
    assert.equal(isToolInstalled(root, "agent-device", version), false);
    const calls: string[][] = [];
    await installNpmTool(root, "agent-device", version, { exec: fakeNpm(calls), download: noDownload, nodePath: "/n", npmCli: "/c", env: {}, downloads: root }, new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.ok(isToolInstalled(root, "agent-device", version));
    assert.deepEqual(calls[0]!.slice(0, 3), ["/c", "ci", "--ignore-scripts"]);
    await installNpmTool(root, "agent-device", version, { exec: fakeNpm(calls), download: noDownload, nodePath: "/n", npmCli: "/c", env: {}, downloads: root }, new AbortController().signal);
    assert.equal(calls.length, 1, "an installed tool is reused");
  });
});

test("prune: keeps the current and the most recent previous version; staging leftovers go", async () => {
  await withDir(async (root) => {
    const make = async (version: string, mtime: number) => {
      const dir = toolDir(root, "agent-device", version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, INSTALL_SENTINEL), "{}");
      await utimes(join(dir, INSTALL_SENTINEL), mtime, mtime);
    };
    await make("1.0.0", 1_000);
    await make("1.1.0", 2_000);
    await make("1.2.0", 3_000);
    await make("2.0.0", 4_000);
    await mkdir(join(root, ".staging-agent-device@3.0.0-abc"));
    await mkdir(join(root, "expo-device-hub@9"));
    const removed = await pruneToolVersions(root, "agent-device", "1.2.0");
    assert.deepEqual(removed.sort(), [".staging-agent-device@3.0.0-abc", "agent-device@1.0.0", "agent-device@1.1.0"]);
    assert.deepEqual((await readdir(root)).sort(), ["agent-device@1.2.0", "agent-device@2.0.0", "expo-device-hub@9"]);
  });
});


test("locks: every pinned tool ships a lock of exactly its version (and the box lock pins both); no other version installs", async () => {
  for (const [name, version] of Object.entries(DEVICE_TOOL_VERSIONS)) {
    const lock = toolLock(name, version);
    assert.ok(lock, `${name}@${version} has a lock`);
    const parsed = JSON.parse(lock.packageLock) as { packages: Record<string, { integrity?: string; resolved?: string }> };
    for (const [path, entry] of Object.entries(parsed.packages)) if (path !== "") assert.ok(entry.integrity && entry.resolved, `${path} is pinned with its integrity`);
    assert.equal(toolLock(name, "0.0.1"), null);
  }
  assert.ok(BOX_TOOLS_LOCK);
  const boxPackage = JSON.parse(BOX_TOOLS_LOCK.packageJson) as { dependencies: Record<string, string> };
  const boxLock = JSON.parse(BOX_TOOLS_LOCK.packageLock) as { packages: Record<string, { version: string }> };
  for (const [name, version] of Object.entries(DEVICE_TOOL_VERSIONS)) {
    assert.equal(boxPackage.dependencies[name], version);
    assert.equal(boxLock.packages[`node_modules/${name}`]!.version, version);
  }
  await withDir(async (root) => {
    const deps = { exec: fakeNpm([]), download: noDownload, nodePath: "/n", npmCli: "/c", env: {}, downloads: root };
    await assert.rejects(installNpmTool(root, "agent-device", "9.9.9", deps, new AbortController().signal), /no lockfile/);
  });
});
