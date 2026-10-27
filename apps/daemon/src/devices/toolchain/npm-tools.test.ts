import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExecFn } from "../android/exec.ts";
import type { DownloadFn } from "./download.ts";
import { BOX_TOOLS_LOCK, INSTALL_SENTINEL, installNpmTool, isToolInstalled, lockPins, pruneToolVersions, SCRCPY_SERVER, scrcpyJarPath, TOOL_ENTRY, toolDir, toolLock } from "./npm-tools.ts";
import { DEVICE_TOOL_VERSIONS } from "./index.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-npm-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A lock pinning `name@version` (tests install versions this build ships no lock for). */
function lockFor(name: string, version: string) {
  return {
    packageJson: JSON.stringify({ name: "orquester-device-tool", private: true, dependencies: { [name]: version } }),
    packageLock: JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${name}`]: { version } } })
  };
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
    const entry = join(prefix, TOOL_ENTRY[name]!.entry);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// entry\n");
    return { exitCode: 0, stdout: "added 1 package", stderr: "" };
  };
}

/** A downloader that writes "jar". */
function fakeDownload(downloads: string[]): DownloadFn {
  return async (file, dest) => {
    downloads.push(file.url);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, "jar");
  };
}

test("install: staging → sentinel → rename; the hub gets its scrcpy jar; installing again is a no-op", async () => {
  await withDir(async (root) => {
    const calls: string[][] = [];
    const downloads: string[] = [];
    // The cached jar is checked against the pinned SHA-256: pin the fake's bytes.
    const scrcpy = { ...SCRCPY_SERVER, sha256: createHash("sha256").update("jar").digest("hex") };
    const deps = { exec: fakeNpm(calls), download: fakeDownload(downloads), nodePath: "/usr/bin/node", npmCli: "/npm-cli.js", env: {}, downloads: join(root, ".dl"), scrcpy, lock: lockFor("expo-device-hub", "1.0.0") };
    {
      const dir = await installNpmTool(root, "expo-device-hub", "1.0.0", deps, new AbortController().signal);
      assert.equal(dir, toolDir(root, "expo-device-hub", "1.0.0"));
      assert.ok(existsSync(join(dir, INSTALL_SENTINEL)));
      assert.ok(existsSync(scrcpyJarPath(dir)));
      assert.ok(isToolInstalled(root, "expo-device-hub", "1.0.0"));
      assert.deepEqual(calls[0]!.slice(0, 3), ["/npm-cli.js", "ci", "--ignore-scripts"]);
      assert.ok(calls[0]!.includes("--no-audit") && calls[0]!.includes("--no-fund"));
      assert.equal(calls[0]!.includes("expo-device-hub@1.0.0"), false, "no spec: the lockfile decides");
      assert.deepEqual(downloads, [SCRCPY_SERVER.url]);
      await installNpmTool(root, "expo-device-hub", "1.0.0", deps, new AbortController().signal);
      assert.equal(calls.length, 1, "already installed");
      assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".staging")), []);
      // The jar removed: repaired in place without reinstalling.
      await rm(scrcpyJarPath(dir));
      assert.equal(isToolInstalled(root, "expo-device-hub", "1.0.0"), false);
      await installNpmTool(root, "expo-device-hub", "1.0.0", deps, new AbortController().signal);
      assert.equal(calls.length, 1);
      assert.ok(isToolInstalled(root, "expo-device-hub", "1.0.0"));
      // A jar that does not match the pin is refused.
      await rm(scrcpyJarPath(dir));
      await assert.rejects(installNpmTool(root, "expo-device-hub", "1.0.0", { ...deps, scrcpy: { ...scrcpy, sha256: "0".repeat(64) } }, new AbortController().signal), /checksum/);
    }
  });
});

test("install: a failed npm leaves nothing installed and no staging dir; the error names npm's last line", async () => {
  await withDir(async (root) => {
    const deps = { exec: fakeNpm([], { fail: true }), download: fakeDownload([]), nodePath: "/n", npmCli: "/c", env: {}, downloads: join(root, ".dl") };
    await assert.rejects(installNpmTool(root, "agent-device", "0.21.31", deps, new AbortController().signal), /404 Not Found/);
    assert.equal(isToolInstalled(root, "agent-device", "0.21.31"), false);
    assert.deepEqual((await readdir(root)).filter((entry) => !entry.startsWith(".agent-device.lock")), []);
  });
});

test("install: a dir without the sentinel is not installed and is replaced", async () => {
  await withDir(async (root) => {
    const half = toolDir(root, "agent-device", "2.0.0");
    await mkdir(join(half, "node_modules", "agent-device", "bin"), { recursive: true });
    await writeFile(join(half, TOOL_ENTRY["agent-device"]!.entry), "");
    assert.equal(isToolInstalled(root, "agent-device", "2.0.0"), false);
    const calls: string[][] = [];
    await installNpmTool(root, "agent-device", "2.0.0", { exec: fakeNpm(calls), download: fakeDownload([]), nodePath: "/n", npmCli: "/c", env: {}, downloads: root, lock: lockFor("agent-device", "2.0.0") }, new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.ok(isToolInstalled(root, "agent-device", "2.0.0"));
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
  assert.ok(BOX_TOOLS_LOCK && lockPins(BOX_TOOLS_LOCK, DEVICE_TOOL_VERSIONS));
  await withDir(async (root) => {
    const deps = { exec: fakeNpm([]), download: fakeDownload([]), nodePath: "/n", npmCli: "/c", env: {}, downloads: root };
    await assert.rejects(installNpmTool(root, "agent-device", "9.9.9", deps, new AbortController().signal), /no lockfile/);
  });
});
