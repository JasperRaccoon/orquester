import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ACCOUNT_ID, type AgentAccount, type AgentAccountsResponse, type SessionSummary } from "@orquester/api";
import { releaseAccountForRemoval } from "./agent-account-removal.ts";

const account = (id: string, extra: Partial<AgentAccount> = {}): AgentAccount =>
  ({ id, agent: "claude", label: id, addedAt: "2026-11-01T00:00:00.000Z", needsReauth: false, ...extra }) as AgentAccount;

const chat = (id: string, accountId: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  kind: "agent-chat",
  refId: "claude",
  accountId,
  title: id,
  projectPath: "/p",
  cwd: "/p",
  cols: 0,
  rows: 0,
  status: "running",
  order: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  activity: { state: "idle", attention: "finished", lastOutputAt: null },
  ...extra
} as SessionSummary);

function harness(sessions: SessionSummary[], accounts: AgentAccountsResponse) {
  const switches: { sessionId: string; accountId: string }[] = [];
  let n = 0;
  return {
    switches,
    run: (id: string) =>
      releaseAccountForRemoval(id, {
        sessions,
        accounts,
        switchAccount: async (sessionId, input) => {
          switches.push({ sessionId, accountId: input.accountId });
        },
        newCommandId: () => `cmd-${n++}`
      })
  };
}

test("a chat whose status light reads working refuses the removal and moves no chat", async () => {
  const h = harness(
    [
      chat("idle", "a"),
      chat("working", "a", { activity: { state: "working", attention: null, lastOutputAt: null } }),
      chat("waiting", "a", { activity: { state: "waiting", attention: "needs-input", lastOutputAt: null } })
    ],
    { accounts: [account("a"), account("b")], defaults: { claude: "b", codex: null, grok: null } }
  );
  const outcome = await h.run("a");
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.error : "", /still working: "working"\. /);
  assert.deepEqual(h.switches, []);
});

test("idle chats move to the agent's default, or another signed-in account when the removed one is the default", async () => {
  const sessions = [chat("one", "a"), chat("two", "a"), chat("other", "b")];
  const accounts = [account("a"), account("stale", { needsReauth: true }), account("b"), account("c")];

  const toDefault = harness(sessions, { accounts, defaults: { claude: "c", codex: null, grok: null } });
  assert.equal((await toDefault.run("a")).ok, true);
  assert.deepEqual(toDefault.switches, [
    { sessionId: "one", accountId: "c" },
    { sessionId: "two", accountId: "c" }
  ]);

  const wasDefault = harness(sessions, { accounts, defaults: { claude: "a", codex: null, grok: null } });
  await wasDefault.run("a");
  assert.deepEqual(wasDefault.switches.map((s) => s.accountId), ["b", "b"]);
});

test("the last account of its agent hands its idle chats to the server's own login", async () => {
  const h = harness([chat("one", "a")], {
    accounts: [account("a"), account("x", { agent: "codex" })],
    defaults: { claude: "a", codex: "x", grok: null }
  });
  await h.run("a");
  assert.deepEqual(h.switches, [{ sessionId: "one", accountId: SYSTEM_ACCOUNT_ID }]);
});
