import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RegistryService } from "./registry.ts";

/**
 * Build a RegistryService with one agent entry whose bin resolves (process.execPath),
 * capture its "changed" broadcasts, and expose an env-file writer for reresolve tests.
 * Mirrors registry-env.test.ts's temp-daemonDir + agents.json override construction.
 */
async function makeRegistryWithResolvedEntry(id: string) {
  const root = await mkdtemp(join(tmpdir(), "orquester-registry-runtime-"));
  await mkdir(join(root, "env"));
  await writeFile(
    join(root, "agents.json"),
    JSON.stringify([{ id, name: id, kind: "agent", bin: [process.execPath] }])
  );
  const registry = new RegistryService(root);
  await registry.init();

  const events: Array<{ entry: any }> = [];
  registry.events.on("changed", (e: any) => {
    if (e.id === id) events.push({ entry: e });
  });
  const writeEnvFile = async (entryId: string, content: string) => {
    await writeFile(join(root, "env", `${entryId}.env`), content);
  };
  return { registry, events, writeEnvFile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("setRuntimeState disables with reason and broadcasts sanitized entry", async () => {
  const { registry, events, cleanup } = await makeRegistryWithResolvedEntry("claudex");
  try {
    registry.setRuntimeState("claudex", { enabled: false, disabledReason: "proxy down" });
    const entry = registry.get("claudex")!;
    assert.equal(entry.enabled, false);
    assert.equal(entry.disabledReason, "proxy down");
    const evt = events.at(-1);
    assert.equal(evt!.entry.disabledReason, "proxy down");
    assert.equal(evt!.entry.env, undefined); // sanitized
  } finally {
    await cleanup();
  }
});

test("reresolve re-reads env file but cannot resurrect a runtime-disabled entry", async () => {
  const { registry, writeEnvFile, cleanup } = await makeRegistryWithResolvedEntry("claudex");
  try {
    registry.setRuntimeState("claudex", { enabled: false, disabledReason: "codex auth expired" });
    await writeEnvFile("claudex", "ANTHROPIC_MODEL=kimi-k3\n");
    await registry.reresolve("claudex");
    const entry = registry.get("claudex")!;
    assert.equal(entry.env?.ANTHROPIC_MODEL, "kimi-k3"); // env reloaded
    assert.equal(entry.enabled, false); // runtime state preserved — the race from spec §2
    assert.equal(entry.disabledReason, "codex auth expired");
  } finally {
    await cleanup();
  }
});

test("setRuntimeState enable is gated by enabledAtRest:false on the real claudex def", async () => {
  // No agents.json override here: the static claudex/claudemix defs carry enabledAtRest:false,
  // so a healthy bin + runtime-enabled must NOT flip them on at rest (only reresolve/status can,
  // and only when the real bin resolves). This guards the def-level gate in computeEnabled.
  const root = await mkdtemp(join(tmpdir(), "orquester-registry-runtime-rest-"));
  const registry = new RegistryService(root);
  await registry.init();
  try {
    const before = registry.get("claudex");
    assert.equal(before?.enabled, false); // enabledAtRest:false keeps it off regardless of bin
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
