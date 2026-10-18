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

test("the profile route is daemon-owned like the account route", () => {
  assert.equal(agentChatRoutes.profile("s1"), "/api/sessions/s1/profile");
  assert.equal(agentChatRoutes.profile("a/b"), "/api/sessions/a%2Fb/profile");
  assert.equal((AGENT_CHAT_COMMAND_NAMES as readonly string[]).includes("profile"), false);
});

test("the head carries the profile from thread.created and a profile switch through thread.meta-updated", () => {
  reset();
  const launched = foldThread([created({ profileId: "p-dev" })] as DomainEvent[]);
  assert.equal(launched.head!.profileId, "p-dev");

  reset();
  const switched = foldThread([
    created({ profileId: "p-dev" }),
    ev("thread.meta-updated", { profileId: "p-edit" })
  ] as DomainEvent[]);
  assert.equal(switched.head!.profileId, "p-edit");
  assert.equal(switched.head!.accountId, "acc-1", "a profile switch keeps the identity");

  reset();
  const global = foldThread([
    created({ profileId: "p-dev" }),
    ev("thread.meta-updated", { profileId: "" })
  ] as DomainEvent[]);
  assert.equal("profileId" in global.head!, false, "the empty string is Global");

  reset();
  const renamed = foldThread([
    created({ profileId: "p-dev" }),
    ev("thread.meta-updated", { title: "Renamed" })
  ] as DomainEvent[]);
  assert.equal(renamed.head!.profileId, "p-dev", "a rename keeps the profile");
});
