/**
 * The composition root, booted for real on a throwaway appdir.
 *
 * Only what the wiring itself owns is asserted here — everything reachable
 * through a seam belongs in that seam's own test. The store's sweep is exactly
 * such a case: W2 owns the sweep and its 6 h interval, and the only thing that
 * can prove the HOST asks for one at boot is a real boot.
 */

import assert from "node:assert/strict";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { agentChatDir } from "@orquester/config";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";

import type { AdapterLogger } from "./adapter.ts";
import { buildRefIdIndex, startAgentHost } from "./main.ts";

const quietLogger = (): AdapterLogger => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
});

/** Wait for a condition the host reaches asynchronously, without sleeping on it. */
async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(label);
}

describe("agent host boot — the store's host-wide sweep (S1 #5)", () => {
  it("sweeps once at boot, so a restart collects what accumulated while it was down", async () => {
    const appdir = await mkdtemp(join(tmpdir(), "agent-host-boot-"));
    try {
      const pendingDir = join(agentChatDir(appdir), "pending-attachments");
      await mkdir(pendingDir, { recursive: true });

      // An upload whose connection died with the previous process. The store's
      // own interval is 6 h, so a host restarted more often than that would
      // never collect this at all.
      const stale = join(pendingDir, "attachment-1-abcdef.part");
      await writeFile(stale, "half an upload");
      const old = new Date(Date.now() - 6 * 60 * 60_000);
      await utimes(stale, old, old);

      // …and one that is still fresh, which must survive.
      const fresh = join(pendingDir, "attachment-2-fedcba.part");
      await writeFile(fresh, "an upload in flight");

      const host = await startAgentHost({
        appdir,
        env: { ...process.env, ORQUESTER_APPDIR: appdir, TMPDIR: join(appdir, "tmp") },
        logger: quietLogger()
      });
      try {
        await host.ready;
        await eventually(async () => {
          const entries = await readdir(pendingDir);
          return !entries.includes("attachment-1-abcdef.part");
        }, "the boot sweep never ran — a dead `.part` outlives every restart");
        assert.ok(await stat(fresh), "an upload still in flight is not collected");
      } finally {
        // `store.close()` runs here; a second stop must stay safe.
        await host.stop();
        await host.stop();
      }
    } finally {
      await rm(appdir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("agent host wiring — the registry refId index (§5.3)", () => {
  it("carries the adapter and the bins, never the row's terminal args", () => {
    // A registry row's `args` are the TERMINAL launcher's flags. Copied into
    // this index they reached every chat launch: every Claude-family thread
    // ran `bypassPermissions` whatever the permission chip said, and the
    // row's `--effort` overruled the effort chip.
    const rows = REGISTRY.agents as readonly RegistryEntryDef[];
    const index = buildRefIdIndex();
    for (const row of rows) {
      if (!row.chat) continue;
      const entry = index.get(row.id);
      assert.ok(entry, `${row.id} is chat-capable, so it is indexed`);
      assert.equal(entry.adapter, row.chat.adapter);
      assert.equal("args" in entry, false, `${row.id}'s terminal args never enter the index`);
    }
    // Not vacuous: the rows the bug came from really do declare such flags.
    const claude = rows.find((row) => row.id === "claude");
    assert.ok(claude?.args?.includes("--dangerously-skip-permissions"));
  });
});
