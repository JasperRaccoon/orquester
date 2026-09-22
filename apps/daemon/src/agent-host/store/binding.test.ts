/**
 * The provider-session binding's merge contract (§3.3, §4.1).
 *
 * The whole point of the file is that a write which says nothing about the
 * cursor cannot erase it, so that is what most of this asserts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderSessionBinding } from "@orquester/api/agent-chat";

import { BINDING_FILE_NAME, bindingResumeCursor, mergeSessionBinding } from "./binding.ts";
import { createThreadStore } from "./index.ts";

const base = (overrides: Partial<ProviderSessionBinding> = {}): ProviderSessionBinding => ({
  threadId: "t1",
  adapter: "claude",
  adapterKey: "claudex",
  runtimeMode: "approval-required",
  providerInstanceId: "account:acc1",
  status: "running",
  resumeCursor: { resume: "sess-1" },
  providerThreadId: "prov-1",
  lastSeenAt: "2026-09-22T00:00:00.000Z",
  ...overrides
});

const merge = (
  existing: ProviderSessionBinding | null,
  patch: Parameters<typeof mergeSessionBinding>[0]["patch"]
): ProviderSessionBinding =>
  mergeSessionBinding({
    threadId: "t1",
    existing,
    patch,
    fallbackAdapter: "claude",
    now: "2026-09-22T01:00:00.000Z"
  });

describe("mergeSessionBinding (§3.3)", () => {
  it("an omitted field is UNCHANGED — the rule the cursor exists for", () => {
    const next = merge(base(), { status: "ready" });
    assert.deepEqual(next.resumeCursor, { resume: "sess-1" });
    assert.equal(next.adapterKey, "claudex");
    assert.equal(next.runtimeMode, "approval-required");
    assert.equal(next.providerInstanceId, "account:acc1");
    assert.equal(next.providerThreadId, "prov-1");
    assert.equal(next.status, "ready");
  });

  it("an explicit `undefined` is also unchanged, never a clear", () => {
    const next = merge(base(), { resumeCursor: undefined, adapterKey: undefined });
    assert.deepEqual(next.resumeCursor, { resume: "sess-1" });
    assert.equal(next.adapterKey, "claudex");
  });

  it("`null` clears, and is distinguishable from an omission", () => {
    const next = merge(base(), {
      resumeCursor: null,
      adapterKey: null,
      runtimeMode: null,
      providerInstanceId: null,
      providerThreadId: null
    });
    assert.equal(next.resumeCursor, null);
    assert.equal(next.adapterKey, null);
    assert.equal(next.runtimeMode, null);
    assert.equal(next.providerInstanceId, null);
    assert.equal(next.providerThreadId, null);
  });

  it("a first write with no existing binding takes the fallback adapter and null defaults", () => {
    const next = merge(null, { resumeCursor: { resume: "fresh" } });
    assert.equal(next.adapter, "claude");
    assert.equal(next.adapterKey, null);
    assert.equal(next.status, "stopped");
    assert.deepEqual(next.resumeCursor, { resume: "fresh" });
  });

  it("an absent cursor is stored as null, never as undefined", () => {
    const next = merge(null, { status: "starting" });
    assert.equal(next.resumeCursor, null);
    assert.ok("resumeCursor" in next);
  });

  it("`lastSeenAt` is always the write's own stamp", () => {
    assert.equal(merge(base(), {}).lastSeenAt, "2026-09-22T01:00:00.000Z");
  });

  it("bindingResumeCursor reports null and a missing binding the same way — `undefined`", () => {
    assert.equal(bindingResumeCursor(null), undefined);
    assert.equal(bindingResumeCursor(base({ resumeCursor: null })), undefined);
    assert.deepEqual(bindingResumeCursor(base()), { resume: "sess-1" });
  });
});

describe("the store's binding file (§8 rollback boundary)", () => {
  const withStore = async (
    run: (input: { store: ReturnType<typeof createThreadStore>; rootDir: string }) => Promise<void>
  ): Promise<void> => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-binding-"));
    const store = createThreadStore({ rootDir, sweepIntervalMs: 0 });
    try {
      await run({ store, rootDir });
    } finally {
      store.close();
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  };

  it("round-trips a cursor through disk and merges the next write field-wise", async () => {
    await withStore(async ({ store, rootDir }) => {
      await store.upsertSessionBinding({
        threadId: "t1",
        adapter: "claude",
        patch: { adapterKey: "claudex", status: "running", resumeCursor: { resume: "sess-1" } }
      });
      // A second store reads what the first wrote — no in-memory shortcut.
      const reader = createThreadStore({ rootDir, sweepIntervalMs: 0 });
      try {
        const loaded = await reader.loadBinding("t1");
        assert.deepEqual(loaded?.resumeCursor, { resume: "sess-1" });
        assert.equal(loaded?.adapterKey, "claudex");
        // A status-only write must not take the cursor with it.
        await reader.upsertSessionBinding({
          threadId: "t1",
          adapter: "claude",
          patch: { status: "stopped" }
        });
        const after = await createThreadStore({ rootDir, sweepIntervalMs: 0 }).loadBinding("t1");
        assert.deepEqual(after?.resumeCursor, { resume: "sess-1" });
        assert.equal(after?.status, "stopped");
      } finally {
        reader.close();
      }
    });
  });

  it("a binding that does not decode reads as absent, never as an error", async () => {
    await withStore(async ({ store, rootDir }) => {
      await store.upsertSessionBinding({
        threadId: "t1",
        adapter: "claude",
        patch: { resumeCursor: { resume: "sess-1" } }
      });
      await fsp.writeFile(path.join(rootDir, "threads", "t1", BINDING_FILE_NAME), "{ not json");
      const reader = createThreadStore({ rootDir, sweepIntervalMs: 0 });
      try {
        assert.equal(await reader.loadBinding("t1"), null);
        assert.equal(reader.threadError("t1"), null, "an unreadable binding never errors the thread");
      } finally {
        reader.close();
      }
    });
  });

  it("a thread with no binding file reads as null", async () => {
    await withStore(async ({ store }) => {
      assert.equal(await store.loadBinding("never-written"), null);
    });
  });

  it("deleting the thread takes its binding with it", async () => {
    await withStore(async ({ store, rootDir }) => {
      await store.upsertSessionBinding({
        threadId: "t1",
        adapter: "claude",
        patch: { resumeCursor: { resume: "sess-1" } }
      });
      await store.deleteThread("t1");
      assert.equal(await store.loadBinding("t1"), null);
      await assert.rejects(fsp.stat(path.join(rootDir, "threads", "t1", BINDING_FILE_NAME)));
    });
  });
});
