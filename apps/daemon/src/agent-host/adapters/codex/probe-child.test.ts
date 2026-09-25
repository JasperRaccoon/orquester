/**
 * Codex adapter — a probe whose child dies before it answers fails at once.
 *
 * A probe (`runProbe`, `index.ts`) handshakes a short-lived `codex app-server`
 * and never watched that child: one that exited before answering left the
 * probe waiting on `initialize` until the 30 s handshake deadline. That timer
 * is ref'd by design (`support/deadline.ts`), so every session start — which
 * forks a probe for its cwd — could hold the process half a minute after the
 * child was gone: the seam tests idled ~30 s after their last assertion
 * whenever their teardown removed the mock before the forked probe's child
 * had read it.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";

import { withDeadline } from "../../support/deadline.ts";
import { createCodexAdapter } from "./index.ts";
import { createFakeContext, writeMockCodexServer } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

describe("codex adapter — the probe's child", () => {
  it("a probe whose child exits before answering fails at once, not at the handshake deadline", async () => {
    const server = writeMockCodexServer({ hangOnInitialize: true, exitAfterMs: 0, exitCode: 1 });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const { context, abort } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin) });
    const adapter = await createCodexAdapter(context);
    cleanups.push(async () => {
      await adapter.stopAll();
      abort.abort();
    });

    // A third of the handshake window: the probe must end with its child.
    const snapshot = await withDeadline(adapter.refreshSnapshot(), {
      label: "the probe of a dead child",
      timeoutMs: 10_000
    });
    assert.equal(snapshot.status, "error");
    assert.match(String(snapshot.message), /exited/);
  });
});
