/**
 * The principal contract (unified MCP design 2026-10-15, coordinator rulings rounds 1–2):
 * principal-gated hints are honoured only for the matching agent principal; socket-trusted fields
 * (`causedBy` on turns and merge-backs, reply subscriptions) are honoured from socket/in-process
 * callers and stripped by the remote transport.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isAgentPrincipalFor,
  PRINCIPAL_ROUTES,
  PRINCIPAL_TOKEN_HEADER,
  PRINCIPAL_TOKEN_INVALID,
  PRINCIPAL_TOKEN_MIN_BYTES,
  PRINCIPAL_TOKEN_TTL_MS,
  USER_PRINCIPAL,
  type CallerPrincipal
} from "./principal.ts";
import { readThreadToolReference } from "./thread-tools.ts";
import { agentChatRoutes, REMOTE_STRIPPED_MERGE_BACK_FIELDS, REMOTE_STRIPPED_TURN_FIELDS, stripRemoteMergeBackFields, stripRemoteTurnFields, type TurnCommandBody } from "./wire.ts";

test("an agent hint is honoured only for that very agent", () => {
  const agent: CallerPrincipal = { kind: "agent", threadId: "t1", projectPath: "/w/ws/app" };
  assert.equal(isAgentPrincipalFor(agent, "t1"), true);
  assert.equal(isAgentPrincipalFor(agent, "t2"), false);
  assert.equal(isAgentPrincipalFor(USER_PRINCIPAL, "t1"), false);
  assert.equal(isAgentPrincipalFor({ kind: "external", credentialId: "c" }, "t1"), false);
  assert.equal(isAgentPrincipalFor(undefined, "t1"), false);
  assert.equal(PRINCIPAL_TOKEN_HEADER, "x-orquester-principal-token");
  assert.ok(PRINCIPAL_ROUTES.some((route) => route.path === "/api/saved-prompts" && route.method === "POST"));
});

test("the remote transport strips causedBy from a turn body, and leaves a clean body as it is", () => {
  const body: TurnCommandBody = { commandId: "c", input: "hi", causedBy: { threadId: "a", exchangeId: "x", hop: 1 } };
  assert.deepEqual(stripRemoteTurnFields(body), { commandId: "c", input: "hi" });
  assert.equal(body.causedBy?.hop, 1, "the input is not changed");
  const clean = { commandId: "c", input: "hi" };
  assert.equal(stripRemoteTurnFields(clean), clean);
  assert.deepEqual([...REMOTE_STRIPPED_TURN_FIELDS], ["causedBy"]);
  // `ifIdle` is a precondition (it can only refuse a turn): accepted from any caller, never stripped.
  const idle: TurnCommandBody = { commandId: "c", input: "hi", ifIdle: true };
  assert.equal(stripRemoteTurnFields(idle), idle);
});

test("a threadRef may name an opened chat", () => {
  assert.deepEqual(readThreadToolReference({ threadId: "c1", title: "Review", relation: "opened" }), { threadId: "c1", title: "Review", relation: "opened" });
});

test("token requirements and gates are written into the contract", () => {
  assert.ok(PRINCIPAL_TOKEN_MIN_BYTES >= 16, "at least 128 bits");
  assert.ok(PRINCIPAL_TOKEN_TTL_MS > 0 && PRINCIPAL_TOKEN_TTL_MS <= 60_000, "short expiry");
  assert.equal(PRINCIPAL_TOKEN_INVALID, "PRINCIPAL_TOKEN_INVALID");
  const gate = (method: string, path: string) => PRINCIPAL_ROUTES.find((route) => route.method === method && route.path === path)?.gate;
  assert.equal(gate("POST", "/api/sessions/:id/turn"), "socket", "workers post /turn without a principal");
  assert.equal(gate("POST", "/api/sessions/:id/reply-subscriptions/:subscriptionId/release"), "socket");
  assert.equal(agentChatRoutes.replySubscriptionRelease("t 1", "s/1"), "/api/sessions/t%201/reply-subscriptions/s%2F1/release");
  assert.equal(gate("POST", "/api/sessions/:id/merge-back"), "socket");
  assert.equal(gate("POST", "/api/sessions/:id/reply-subscriptions"), "socket");
  assert.equal(gate("POST", "/api/sessions"), "principal");
  assert.equal(gate("POST", "/api/sessions/:id/fork"), "principal");
  assert.equal(gate("PUT", "/api/saved-prompts/:id"), "principal");
  assert.equal(gate("POST", "/api/push/notify"), "principal");
});

test("the remote transport strips causedBy from a merge-back body too", () => {
  const body = { text: "done", commandId: "m1", causedBy: { threadId: "a", exchangeId: "x", hop: 2 } };
  assert.deepEqual(stripRemoteMergeBackFields(body), { text: "done", commandId: "m1" });
  const clean = { text: "done" };
  assert.equal(stripRemoteMergeBackFields(clean), clean);
  assert.deepEqual([...REMOTE_STRIPPED_MERGE_BACK_FIELDS], ["causedBy"]);
});
