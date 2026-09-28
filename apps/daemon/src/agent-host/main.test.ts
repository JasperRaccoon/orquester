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
import { watch } from "node:fs";

import { agentChatDir } from "@orquester/config";

import type { AdapterLogger } from "./adapter.ts";
import { startAgentHost } from "./main.ts";

const quietLogger = (): AdapterLogger => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
});

describe("agent host boot — the store's host-wide sweep (S1 #5)", () => {
  it("sweeps once at boot, so a restart collects what accumulated while it was down", async (t) => {
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

      const swept = new Promise<void>((resolve, reject) => {
        const watcher = watch(pendingDir, { signal: AbortSignal.timeout(10_000) }, (_event, filename) => {
          if (filename === "attachment-1-abcdef.part") resolve();
        });
        watcher.once("error", reject);
        watcher.once("close", () => reject(new Error("boot sweep produced no filesystem event")));
        t.after(() => watcher.close());
      });

      const host = await startAgentHost({
        appdir,
        // No provider CLI on this host's PATH: the boot refresh must not probe
        // the machine's real ones — their probes outlived the test and wrote
        // their temp dirs back into the removed appdir.
        env: { HOME: appdir, PATH: "/usr/bin:/bin", ORQUESTER_APPDIR: appdir, TMPDIR: join(appdir, "tmp") },
        logger: quietLogger()
      });
      try {
        await host.ready;
        await swept;
        assert.equal((await readdir(pendingDir)).includes("attachment-1-abcdef.part"), false);
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
