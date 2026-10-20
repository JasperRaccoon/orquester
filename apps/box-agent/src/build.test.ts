import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { open, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BOX_AGENT_PLATFORMS } from "@orquester/api";

import { buildBoxAgent, executableFormat, goTargetFor } from "./build.ts";

const haveGo = spawnSync(process.env.GO || "go", ["version"], { stdio: "ignore" }).status === 0;

test("goTargetFor maps every platform", () => {
  for (const platform of BOX_AGENT_PLATFORMS) {
    const target = goTargetFor(platform);
    assert.ok(["linux", "darwin", "windows"].includes(target.goos));
    assert.equal(target.exe.endsWith(".exe"), platform.startsWith("win32-"));
  }
  assert.throws(() => goTargetFor("plan9-x64"));
});

test("every platform cross-compiles and links for its OS and CPU", { skip: haveGo ? false : "Go toolchain not installed", timeout: 1_800_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), "orq-agent-build-"));
  try {
    const manifest = await buildBoxAgent({ outDir: out, version: "0.0.0+test" });
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [...BOX_AGENT_PLATFORMS].sort());
    assert.deepEqual(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")), manifest);
    for (const platform of BOX_AGENT_PLATFORMS) {
      const target = goTargetFor(platform);
      const handle = await open(join(out, platform, target.exe), "r");
      const header = Buffer.alloc(4096);
      await handle.read(header, 0, header.length, 0);
      await handle.close();
      const format = executableFormat(header);
      const expected = { linux: "elf", darwin: "macho", windows: "pe" }[target.goos];
      assert.deepEqual(format, { format: expected, arch: target.goarch === "amd64" ? "x64" : "arm64" }, platform);
      assert.match(manifest.platforms[platform]!.sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
