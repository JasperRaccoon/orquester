/**
 * The agent principal contract and the trusted-path-only turn fields (unified MCP design
 * 2026-10-15, coordinator ruling): body hints are honoured only for the matching agent principal,
 * and the remote transport strips `causedBy`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isAgentPrincipalFor, PRINCIPAL_ROUTES, PRINCIPAL_TOKEN_HEADER, USER_PRINCIPAL, type CallerPrincipal } from "./principal.ts";
import { readThreadToolReference } from "./thread-tools.ts";
import { REMOTE_STRIPPED_TURN_FIELDS, stripRemoteTurnFields, type TurnCommandBody } from "./wire.ts";

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
});

test("a threadRef may name an opened chat", () => {
  assert.deepEqual(readThreadToolReference({ threadId: "c1", title: "Review", relation: "opened" }), { threadId: "c1", title: "Review", relation: "opened" });
});
