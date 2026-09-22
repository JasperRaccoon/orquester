import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAccount } from "@orquester/api";
import { overlayManagedAccountAuth } from "./provider-auth-overlay.ts";

const account = (over: Partial<AgentAccount>): AgentAccount => ({
  id: "acc-1",
  agent: "claude",
  label: "Work",
  email: "w@example.com",
  plan: "max",
  needsReauth: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  importedAt: "2026-01-01T00:00:00.000Z",
  ...over
});

interface Snap {
  id: string;
  status: string;
  message?: string;
  auth: { status: string; type?: string; label?: string; email?: string };
}

const snapshot = (over: Partial<Snap>): Snap => ({
  id: "claude",
  status: "ready",
  auth: { status: "unauthenticated", type: "firstParty" },
  ...over
});

describe("managed-account auth overlay (§7.7)", () => {
  it("a stale system login is covered by one valid managed account", () => {
    const out = overlayManagedAccountAuth(snapshot({}), [account({})]);
    assert.equal(out.auth.status, "authenticated");
    assert.equal(out.auth.label, "Work");
    assert.equal(out.auth.email, "w@example.com");
  });

  it("stays unauthenticated when every managed account needs re-auth", () => {
    const out = overlayManagedAccountAuth(snapshot({}), [account({ needsReauth: true })]);
    assert.equal(out.auth.status, "unauthenticated");
  });

  it("only the provider's own family counts", () => {
    const out = overlayManagedAccountAuth(snapshot({}), [account({ agent: "codex" })]);
    assert.equal(out.auth.status, "unauthenticated");
  });

  it("opencode has no account family and is left alone", () => {
    const out = overlayManagedAccountAuth(snapshot({ id: "opencode" }), [account({})]);
    assert.equal(out.auth.status, "unauthenticated");
  });

  it("an authenticated probe is returned as-is", () => {
    const input = snapshot({ auth: { status: "authenticated", label: "System" } });
    assert.equal(overlayManagedAccountAuth(input, [account({})]), input);
  });

  it("an error that was only the missing login becomes ready, message dropped", () => {
    const out = overlayManagedAccountAuth(
      snapshot({ id: "grok", status: "error", message: "Grok CLI is installed but not logged in." }),
      [account({ agent: "grok" })]
    );
    assert.equal(out.status, "ready");
    assert.equal("message" in out, false);
    assert.equal(out.auth.status, "authenticated");
  });

  it("a non-auth error keeps its status and text", () => {
    const out = overlayManagedAccountAuth(
      snapshot({ status: "error", message: "codex was not found.", auth: { status: "unknown" } }),
      [account({ agent: "codex", id: "c" })]
    );
    assert.equal(out.status, "error");
    assert.equal(out.message, "codex was not found.");
    assert.equal(out.auth.status, "unknown", "an unknown verdict is not an auth failure");
  });

  it("prefers the family default account for the label", () => {
    const out = overlayManagedAccountAuth(
      snapshot({}),
      [account({ id: "a", label: "A" }), account({ id: "b", label: "B" })],
      { claude: "b" }
    );
    assert.equal(out.auth.label, "B");
  });
});
