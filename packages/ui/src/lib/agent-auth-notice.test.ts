import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_AUTH_DISMISSAL_LIMIT,
  agentAuthNoticeKey,
  rememberAgentAuthDismissal,
  shouldRaiseAgentAuthNotice
} from "./agent-auth-notice.ts";

const claude = { sessionId: "provider:claude", message: "Session expired." };

test("a fresh notice is raised", () => {
  assert.equal(shouldRaiseAgentAuthNotice(claude, []), true);
});

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

test("a notice from an older bundle, carrying no columns, still keys and dismisses", () => {
  const legacy = { sessionId: "provider:codex", message: "Session expired." };
  const dismissed = rememberAgentAuthDismissal(legacy, []);
  assert.equal(shouldRaiseAgentAuthNotice(legacy, dismissed), false);
});

test("the key cannot be forged by a message containing the separator", () => {
  // A NUL separator, so a message can never spell another provider's key.
  assert.notEqual(
    agentAuthNoticeKey({ sessionId: "a", message: "b" }),
    agentAuthNoticeKey({ sessionId: "a\u0000b", message: "" })
  );
});

test("dismissals are deduped and bounded", () => {
  const once = rememberAgentAuthDismissal(claude, []);
  assert.equal(rememberAgentAuthDismissal(claude, once), once, "same list, no growth");

  let dismissed: readonly string[] = [];
  for (let i = 0; i < AGENT_AUTH_DISMISSAL_LIMIT + 5; i++) {
    dismissed = rememberAgentAuthDismissal({ sessionId: "p", message: `m${i}` }, dismissed);
  }
  assert.equal(dismissed.length, AGENT_AUTH_DISMISSAL_LIMIT);
  // The newest survive.
  assert.equal(
    shouldRaiseAgentAuthNotice({ sessionId: "p", message: `m${AGENT_AUTH_DISMISSAL_LIMIT + 4}` }, dismissed),
    false
  );
});
