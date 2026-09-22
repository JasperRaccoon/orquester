/**
 * The composer's account chip (spec §3.4, §7.4) — the gate, the option list
 * and the labels, all pure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAccount } from "@orquester/api";

import {
  buildChatAccountOptions,
  canSwitchChatAccount,
  chatAccountLabel,
  chatAccountSelectionId,
  chatAccountSwitchSupported,
  identityChangeSummary,
  isProxyLauncher,
  PROXY_ACCOUNT_FAMILY,
  type ChatAccountSwitchState
} from "./account-switch.ts";

const shortLabel = (label: string | undefined): string | undefined =>
  label === undefined ? undefined : label.split("@")[0];

function account(overrides: Partial<AgentAccount> & Pick<AgentAccount, "id" | "agent">): AgentAccount {
  return {
    label: `${overrides.id}@example.com`,
    email: null,
    plan: null,
    needsReauth: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    importedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const ACCOUNTS: AgentAccount[] = [
  account({ id: "cla-1", agent: "claude" }),
  account({ id: "cla-2", agent: "claude", needsReauth: true }),
  account({ id: "cod-1", agent: "codex" }),
  account({ id: "grk-1", agent: "grok" })
];

const idle: ChatAccountSwitchState = {
  isTurnActive: false,
  hasPendingRequest: false,
  queuedCount: 0,
  reverting: false,
  connection: "synchronized",
  backgroundLive: false
};

describe("the option list", () => {
  it("offers System plus the launcher's OWN family", () => {
    const options = buildChatAccountOptions({
      refId: "claude",
      accounts: ACCOUNTS,
      shortLabel
    });
    assert.deepEqual(
      options.map((option) => option.id),
      ["system", "cla-1", "cla-2"]
    );
    assert.equal(options[0]!.label, "System");
    assert.equal(options[1]!.label, "cla-1");
    assert.equal(options[2]!.needsReauth, true, "a stale account is offered, flagged");
  });

  it("a proxy launcher draws from the MAPPED family and only what is seeded", () => {
    assert.deepEqual(PROXY_ACCOUNT_FAMILY, { claudemix: "claude", claudex: "codex" });
    assert.equal(isProxyLauncher("claudex"), true);
    assert.equal(isProxyLauncher("claude"), false);

    // claudex → codex accounts, and only the seeded ones: an unseeded pin
    // emits an `acc<hex>/` prefix no auth file serves.
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudex",
        accounts: ACCOUNTS,
        seededAccountIds: ["cod-1"],
        shortLabel
      }).map((option) => option.id),
      ["system", "cod-1"]
    );
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudex",
        accounts: ACCOUNTS,
        seededAccountIds: [],
        shortLabel
      }).map((option) => option.id),
      ["system"],
      "nothing seeded means System only"
    );
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudemix",
        accounts: ACCOUNTS,
        seededAccountIds: ["cla-1", "cod-1"],
        shortLabel
      }).map((option) => option.id),
      ["system", "cla-1"]
    );
  });

  it("OpenCode has no per-thread account, decided without waiting for a snapshot", () => {
    assert.equal(chatAccountSwitchSupported({ refId: "opencode" }), false);
    assert.equal(
      chatAccountSwitchSupported({ refId: "opencode", adapterId: undefined }),
      false,
      "the registry id alone is enough — the snapshot may not have landed"
    );
    assert.equal(chatAccountSwitchSupported({ refId: "claude", adapterId: "opencode" }), false);
    assert.equal(chatAccountSwitchSupported({ refId: "claude", adapterId: "claude" }), true);
    assert.equal(chatAccountSwitchSupported({ refId: "claudex" }), true);
  });

  it("an empty accounts list is still a usable menu", () => {
    assert.deepEqual(
      buildChatAccountOptions({ refId: "claude", accounts: undefined, shortLabel }).map(
        (option) => option.id
      ),
      ["system"]
    );
  });
});

describe("the idle gate", () => {
  it("opens only when nothing is in flight", () => {
    assert.equal(canSwitchChatAccount(idle), true);
  });

  it("closes for every in-flight shape", () => {
    const closed: Array<Partial<ChatAccountSwitchState>> = [
      { isTurnActive: true },
      { hasPendingRequest: true },
      { queuedCount: 1 },
      { reverting: true },
      { connection: "connecting" },
      { connection: "reconnecting" },
      { backgroundLive: true }
    ];
    for (const patch of closed) {
      assert.equal(
        canSwitchChatAccount({ ...idle, ...patch }),
        false,
        `closed for ${JSON.stringify(patch)}`
      );
    }
  });
});

describe("labels", () => {
  it("reads System for the sentinel, an absent id and an unknown id", () => {
    assert.equal(chatAccountLabel({ accountId: "system", accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: undefined, accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: "", accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: "gone", accounts: ACCOUNTS, shortLabel }), "System");
  });

  it("resolves a managed account through the live list, not the log", () => {
    assert.equal(chatAccountLabel({ accountId: "cla-1", accounts: ACCOUNTS, shortLabel }), "cla-1");
  });

  it("the system identity's two spellings map onto the menu's one id", () => {
    // The head and the tab record say `""`/`undefined`; the menu says `system`.
    // Without this the System row never shows its checkmark.
    assert.equal(chatAccountSelectionId(""), "system");
    assert.equal(chatAccountSelectionId(undefined), "system");
    assert.equal(chatAccountSelectionId("cla-1"), "cla-1");
    const options = buildChatAccountOptions({ refId: "claude", accounts: ACCOUNTS, shortLabel });
    assert.ok(options.some((option) => option.id === chatAccountSelectionId("")));
  });

  it("the timeline row names the account it switched to, and degrades gracefully", () => {
    assert.equal(
      identityChangeSummary({
        payload: { accountId: "cla-1", home: "account" },
        accounts: ACCOUNTS,
        shortLabel
      }),
      "Switched to cla-1"
    );
    assert.equal(
      identityChangeSummary({
        payload: { accountId: "", home: "system" },
        accounts: ACCOUNTS,
        shortLabel
      }),
      "Switched to System"
    );
    // An older bundle's payload, or none at all.
    assert.equal(
      identityChangeSummary({ payload: {}, accounts: ACCOUNTS, shortLabel }),
      "Switched account"
    );
    assert.equal(
      identityChangeSummary({ payload: null, accounts: ACCOUNTS, shortLabel }),
      "Switched account"
    );
  });
});
