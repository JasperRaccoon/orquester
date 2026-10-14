/**
 * The client's copy of the pending `request_secret` cards (design 2026-10-14
 * §5): bus events and loads converge, a closed card never comes back, and a
 * malformed payload never reaches state.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { SecretRequestListResponse, SecretRequestSummary } from "@orquester/api/agent-chat";

import {
  applySecretRequestEvent,
  loadSecretRequests,
  markSecretRequestClosed,
  resetSecretRequests,
  secretRequestsFor,
  secretRequestsStore
} from "./secret-requests";

const request = (requestId: string, sessionId = "s1", createdAt = `2026-10-14T10:00:0${requestId.slice(-1)}.000Z`): SecretRequestSummary => ({
  requestId,
  sessionId,
  name: "API_KEY",
  prompt: "Paste it.",
  createdAt
});
const event = (summary: SecretRequestSummary, open: boolean) => ({
  type: "agentChat.secretRequest",
  payload: { id: summary.sessionId, request: summary, open, ...(open ? {} : { outcome: "provided" }) }
});
const pending = (sessionId = "s1") => secretRequestsFor(secretRequestsStore.getState(), sessionId).map((entry) => entry.requestId);

/** A list route whose answer the test releases. */
function deferredApi() {
  let release!: (response: SecretRequestListResponse) => void;
  const answered = new Promise<SecretRequestListResponse>((resolve) => {
    release = resolve;
  });
  return { api: { listSecretRequests: () => answered }, release };
}

describe("secret requests — the client's copy", () => {
  beforeEach(() => resetSecretRequests());

  it("opens and closes on bus events, oldest first, per session", () => {
    applySecretRequestEvent(event(request("r2"), true));
    applySecretRequestEvent(event(request("r1"), true));
    applySecretRequestEvent(event(request("r3", "s2"), true));
    assert.deepEqual(pending(), ["r1", "r2"]);
    assert.deepEqual(pending("s2"), ["r3"]);
    applySecretRequestEvent(event(request("r1"), false));
    assert.deepEqual(pending(), ["r2"]);
    // A late open of a closed card does not bring it back.
    applySecretRequestEvent(event(request("r1"), true));
    assert.deepEqual(pending(), ["r2"]);
  });

  it("ignores anything that is not a well-formed secret-request event", () => {
    for (const bad of [
      { type: "agentChat.pending", payload: { request: request("x"), open: true } },
      { type: "agentChat.secretRequest", payload: null },
      { type: "agentChat.secretRequest", payload: { request: request("x"), open: "yes" } },
      { type: "agentChat.secretRequest", payload: { request: { requestId: "x" }, open: true } }
    ]) {
      applySecretRequestEvent(bad);
    }
    assert.deepEqual(secretRequestsStore.getState().bySession, {});
  });

  it("a load replaces the session's list, keeps what opened meanwhile, never revives what closed", async () => {
    applySecretRequestEvent(event(request("stale"), true));
    const { api, release } = deferredApi();
    const loading = loadSecretRequests(api, "s1");
    applySecretRequestEvent(event(request("r9"), true)); // opened while loading
    applySecretRequestEvent(event(request("r1"), false)); // closed while loading
    release({ requests: [request("r1"), request("r2"), { ...request("r3"), sessionId: "elsewhere" }] });
    await loading;
    assert.deepEqual(pending(), ["r2", "r9"], "stale dropped, r1 stays closed, another session's entry ignored");
  });

  it("an answered card leaves at once; a reset drops everything and any load in flight", async () => {
    applySecretRequestEvent(event(request("r1"), true));
    markSecretRequestClosed("s1", "r1");
    assert.deepEqual(pending(), []);
    const { api, release } = deferredApi();
    const loading = loadSecretRequests(api, "s1");
    resetSecretRequests();
    release({ requests: [request("r2")] });
    await loading;
    assert.deepEqual(pending(), [], "the old connection's answer is dropped");
  });

  it("a failed load leaves the copy as it was", async () => {
    applySecretRequestEvent(event(request("r1"), true));
    await loadSecretRequests({ listSecretRequests: () => Promise.reject(new Error("offline")) }, "s1");
    assert.deepEqual(pending(), ["r1"]);
  });
});
