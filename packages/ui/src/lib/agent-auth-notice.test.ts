import test from "node:test";
import assert from "node:assert/strict";

import { rememberAgentAuthDismissal, shouldRaiseAgentAuthNotice } from "./agent-auth-notice.ts";

const claude = { sessionId: "provider:claude", message: "Session expired." };

test("a dismissal sticks across the re-publish the provider load causes", () => {
  // The regression: `agent.providers.changed` forces a reload, the publisher
  // re-fires the same error, and an overwriting sink made the toast
  // un-dismissable for as long as the provider stayed signed out.
  const dismissed = rememberAgentAuthDismissal(claude, []);
  assert.equal(shouldRaiseAgentAuthNotice(claude, dismissed), false);
  assert.equal(shouldRaiseAgentAuthNotice(claude, dismissed), false);
});

test("a DIFFERENT message on the same provider still gets through", () => {
  const dismissed = rememberAgentAuthDismissal(claude, []);
  assert.equal(
    shouldRaiseAgentAuthNotice({ ...claude, message: "Refresh token revoked." }, dismissed),
    true
  );
});

test("the same message on a different provider still gets through", () => {
  const dismissed = rememberAgentAuthDismissal(claude, []);
  assert.equal(
    shouldRaiseAgentAuthNotice({ ...claude, sessionId: "provider:codex" }, dismissed),
    true
  );
});

test("the key spans [adapterId, status, auth.status, message] (T3's banner key)", () => {
  // *T3: `ProviderStatusBanner.tsx:20-23`.* A snapshot whose status or auth
  // verdict MOVED is a different result and must re-toast; a snapshot that
  // merely arrived again is the same one and must not.
  const errored = {
    sessionId: "provider:claude",
    message: "401 from the API",
    providerStatus: "error",
    authStatus: "unknown"
  };
  const dismissed = rememberAgentAuthDismissal(errored, []);
  assert.equal(
    shouldRaiseAgentAuthNotice(errored, dismissed),
    false,
    "the same result never re-toasts"
  );
  assert.equal(
    shouldRaiseAgentAuthNotice({ ...errored, authStatus: "unauthenticated" }, dismissed),
    true,
    "an ambiguity turning into a verdict is new news"
  );
  assert.equal(
    shouldRaiseAgentAuthNotice({ ...errored, providerStatus: "degraded" }, dismissed),
    true
  );
});
