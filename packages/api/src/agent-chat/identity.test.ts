/**
 * Switching a thread's managed account (spec §3.4, §6.1, §6.2).
 *
 * `thread.meta-updated` is the ONE writer of head-shaped metadata, so the
 * account switch rides it rather than inventing a second event type — and the
 * head projection has to carry the two new fields, or the client would render
 * the old identity until the next reload.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CHAT_COMMAND_NAMES, agentChatRoutes } from "./wire.ts";
import { foldThread } from "./fold.ts";
import type { DomainEvent } from "./domain-events.ts";
import { created, ev, resetActivityIds, resetSeq } from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

test("the account route is daemon-owned: a path, never a proxied command name", () => {
  assert.equal(agentChatRoutes.account("s1"), "/api/sessions/s1/account");
  assert.equal(agentChatRoutes.account("a/b"), "/api/sessions/a%2Fb/account");
  assert.ok(!(AGENT_CHAT_COMMAND_NAMES as readonly string[]).includes("account"));
});

test("thread.meta-updated carries the new identity onto the head", () => {
  reset();
  const state = foldThread([
    created({ accountId: "acc-old", home: "account" }),
    ev("thread.meta-updated", { accountId: "acc-new", home: "account" })
  ] as DomainEvent[]);
  assert.equal(state.head!.accountId, "acc-new");
  assert.equal(state.head!.home, "account");
});

test("a meta update that names neither identity field leaves the head's identity alone", () => {
  reset();
  const state = foldThread([
    created({ accountId: "acc-old", home: "account" }),
    ev("thread.meta-updated", { title: "Renamed" })
  ] as DomainEvent[]);
  assert.equal(state.head!.accountId, "acc-old");
  assert.equal(state.head!.home, "account");
  assert.equal(state.head!.title, "Renamed");
});

test("switching to the system identity clears the account id through the same event", () => {
  reset();
  const state = foldThread([
    created({ accountId: "acc-old", home: "account" }),
    ev("thread.meta-updated", { accountId: "", home: "system" })
  ] as DomainEvent[]);
  assert.equal(state.head!.accountId, "");
  assert.equal(state.head!.home, "system");
});
