import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildBoxAgent } from "./build.ts";

const haveGo = spawnSync(process.env.GO || "go", ["version"], { stdio: "ignore" }).status === 0;

// Independent platform/ABI expectations: do not obtain these from the builder's target mapper.
const targets = {
  "linux-x64": { exe: "orq-agent", format: "elf", arch: "x64" },
  "linux-arm64": { exe: "orq-agent", format: "elf", arch: "arm64" },
  "linux-x64-musl": { exe: "orq-agent", format: "elf", arch: "x64" },
  "linux-arm64-musl": { exe: "orq-agent", format: "elf", arch: "arm64" },
  "darwin-arm64": { exe: "orq-agent", format: "macho", arch: "arm64" },
  "darwin-x64": { exe: "orq-agent", format: "macho", arch: "x64" },
  "win32-x64": { exe: "orq-agent.exe", format: "pe", arch: "x64" }
};

test("every platform cross-compiles and links for its OS and CPU", { skip: haveGo ? false : "Go toolchain not installed", timeout: 1_800_000 }, async (t) => {
  const out = await mkdtemp(join(tmpdir(), "orq-agent-build-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const manifest = await buildBoxAgent({ outDir: out, version: "0.0.0+test" });
  assert.equal(manifest.version, "0.0.0+test");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(targets).sort());
  assert.deepEqual(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")), manifest);
  for (const [platform, target] of Object.entries(targets)) {
    const binary = await readFile(join(out, platform, target.exe));
    assert.deepEqual(executableFormat(binary), { format: target.format, arch: target.arch }, platform);
    assert.equal(manifest.platforms[platform]!.sha256, createHash("sha256").update(binary).digest("hex"));
    assert.equal(manifest.platforms[platform]!.size, binary.length);
  }
  await assert.rejects(buildBoxAgent({ outDir: out, version: "test", platforms: ["plan9-x64"] }), /plan9-x64/);
});
/** What the executable header says it was built for (a link-level sanity check). */
function executableFormat(header: Uint8Array): { format: "elf" | "macho" | "pe"; arch: "x64" | "arm64" } | null {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    const machine = view.getUint16(18, true);
    return machine === 0x3e ? { format: "elf", arch: "x64" } : machine === 0xb7 ? { format: "elf", arch: "arm64" } : null;
  }
  if (header.length >= 8 && view.getUint32(0, true) === 0xfeedfacf) {
    const cpu = view.getUint32(4, true);
    return cpu === 0x01000007 ? { format: "macho", arch: "x64" } : cpu === 0x0100000c ? { format: "macho", arch: "arm64" } : null;
  }
  if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = view.getUint32(60, true);
    if (peOffset + 6 > header.length || view.getUint32(peOffset, true) !== 0x00004550) return null;
    const machine = view.getUint16(peOffset + 4, true);
    return machine === 0x8664 ? { format: "pe", arch: "x64" } : machine === 0xaa64 ? { format: "pe", arch: "arm64" } : null;
  }
  return null;
}
