/**
 * Agent host — the PENDING snapshot each adapter seeds (spec §3.2 layer one).
 *
 * *T3: `apps/server/src/provider/makeManagedServerProvider.ts:69-73`
 * (`initialSnapshot`), `apps/server/src/provider/Layers/ClaudeProvider.ts:595-640`
 * (`makePendingClaudeProvider`).*
 *
 * The invariants are asserted **across every adapter at once** rather than one
 * test per provider: a fifth adapter added later inherits them, and a pending
 * shape that drifts on one provider fails here rather than on a VPS.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ADAPTER_IDS, ADAPTER_PENDING_SNAPSHOTS } from "./index.ts";
import { isPendingSnapshot } from "./pending.ts";

const CHECKED_AT = "1970-01-01T00:00:00.000Z";

describe("§3.2 layer one: every adapter's pendingSnapshot()", () => {

  for (const id of ADAPTER_IDS) {
    describe(id, () => {
      const snapshot = ADAPTER_PENDING_SNAPSHOTS[id](CHECKED_AT);

      it("is synchronous and self-describing", () => {
        assert.equal(snapshot.id, id);
        assert.ok(snapshot.refIds.includes(id), "its own registry id is served");
        assert.equal(snapshot.checkedAt, CHECKED_AT, "the caller's clock, no I/O of its own");
        assert.equal(snapshot.installed, false);
        assert.equal(snapshot.version, null);
      });

      it("claims no verdict: status unknown, auth unknown, the T3 message", () => {
        assert.equal(snapshot.status, "unknown");
        assert.equal(snapshot.auth.status, "unknown");
        assert.match(snapshot.message ?? "", /has not been checked in this session yet\.$/);
        assert.ok(isPendingSnapshot(snapshot));
      });

    });
  }

  it("isPendingSnapshot rejects a real probe result", () => {
    assert.equal(
      isPendingSnapshot({ status: "ready", auth: { status: "authenticated" }, installed: true }),
      false
    );
    // An uninstalled provider IS probed — it reached an `error` verdict.
    assert.equal(
      isPendingSnapshot({ status: "error", auth: { status: "unknown" }, installed: false }),
      false
    );
    // The collision that makes the message load-bearing: OpenCode's
    // "not installed" snapshot wears the same three flags as a pending seed,
    // and is a real verdict that must still be cached.
    assert.equal(
      isPendingSnapshot({
        status: "unknown",
        auth: { status: "unknown" },
        installed: false,
        message: "OpenCode is not installed. Orquester requires v0.15.0 or newer."
      }),
      false
    );
    assert.equal(
      isPendingSnapshot({ status: "unknown", auth: { status: "unknown" }, installed: false }),
      false,
      "no message at all is not a pending seed either"
    );
  });
});
