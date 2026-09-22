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
import { isPendingSnapshot, pendingStatusMessage } from "./pending.ts";

const CHECKED_AT = "1970-01-01T00:00:00.000Z";

/**
 * The client's own toast gate, restated (`packages/ui/src/lib/agent-chat/
 * providers.ts`'s `authErrorMessage`). The UI package is not a daemon
 * dependency, so this is the only honest way to pin the CONTRACT here.
 */
function clientWouldToast(snapshot: {
  status: string;
  auth: { status: string };
}): boolean {
  if (snapshot.auth.status === "unauthenticated") return true;
  return snapshot.status === "error" && snapshot.auth.status !== "authenticated";
}

/**
 * The client's `resolveLaunchModel` (`packages/ui/src/lib/launch-models.ts`),
 * restated for the same reason: `@orquester/ui` is not a daemon dependency,
 * and what matters here is that a pending catalogue RESOLVES.
 */
function resolveLaunchModelSlug(models: readonly { slug: string; isDefault?: boolean }[]): string | null {
  if (models.length === 0) return null;
  return models.find((model) => model.isDefault)?.slug ?? models[0]?.slug ?? null;
}

describe("§3.2 layer one: every adapter's pendingSnapshot()", () => {
  it("covers every adapter id", () => {
    assert.deepEqual(Object.keys(ADAPTER_PENDING_SNAPSHOTS).sort(), [...ADAPTER_IDS].sort());
  });

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

      it("never raises the client's 'sign in again' toast", () => {
        // The bug this whole layer must not reintroduce: a provider nobody has
        // looked at is not a provider that failed to authenticate.
        assert.notEqual(snapshot.status, "error");
        assert.equal(clientWouldToast(snapshot), false);
      });

      it("carries the capability block the client cannot render without", () => {
        assert.ok(snapshot.capabilities);
        assert.equal(typeof snapshot.capabilities.reportsContextWindow, "boolean");
        assert.ok(snapshot.capabilities.compaction);
      });

      it("has a resolvable catalogue, or genuinely none", () => {
        // §3.2: a pending snapshot with a catalogue is LAUNCHABLE; one without
        // is the honest "there is nothing to name yet" the client reports.
        const slug = resolveLaunchModelSlug(snapshot.models);
        if (snapshot.models.length === 0) {
          assert.equal(slug, null);
        } else {
          assert.ok(slug !== null && slug.length > 0);
        }
      });
    });
  }

  it("Claude and Grok ship a bundled catalogue, so their launchers work on a cold host", () => {
    // These two can name their model families without asking the CLI; Codex and
    // OpenCode read theirs off a live server, so `[]` there is deliberate.
    assert.ok(ADAPTER_PENDING_SNAPSHOTS.claude(CHECKED_AT).models.length > 0);
    assert.ok(ADAPTER_PENDING_SNAPSHOTS.grok(CHECKED_AT).models.length > 0);
  });

  it("Claude's pending catalogue names a default", () => {
    const models = ADAPTER_PENDING_SNAPSHOTS.claude(CHECKED_AT).models;
    assert.equal(models.filter((model) => model.isDefault).length, 1);
    assert.deepEqual(
      models.map((model) => model.slug),
      ["default", "opus", "sonnet", "haiku", "fable"]
    );
  });

  it("every pending catalogue is free of duplicate slugs", () => {
    for (const id of ADAPTER_IDS) {
      const slugs = ADAPTER_PENDING_SNAPSHOTS[id](CHECKED_AT).models.map((model) => model.slug);
      assert.equal(new Set(slugs).size, slugs.length, id);
    }
  });

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

  it("pendingStatusMessage is T3's sentence", () => {
    assert.equal(
      pendingStatusMessage("Claude"),
      "Claude provider status has not been checked in this session yet."
    );
  });
});
