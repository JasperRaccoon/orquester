import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  agentAccountsFile,
  agentAccountHome
} from "./index.ts";

test("createDefaultAgentAccounts is empty with null defaults", () => {
  const d = createDefaultAgentAccounts();
  assert.deepEqual(d.accounts, []);
  assert.deepEqual(d.defaults, { claude: null, codex: null });
});

test("parseAgentAccounts fills defaults and coerces missing fields", () => {
  const parsed = parseAgentAccounts({
    accounts: [{ id: "a1", agent: "claude", label: "Work", createdAt: "t", importedAt: "t" }]
  });
  assert.equal(parsed.accounts[0].email, null);
  assert.equal(parsed.accounts[0].plan, null);
  assert.equal(parsed.accounts[0].needsReauth, false);
  assert.deepEqual(parsed.defaults, { claude: null, codex: null });
});

test("parseAgentAccounts rejects an unknown agent", () => {
  assert.throws(() => parseAgentAccounts({ accounts: [{ id: "x", agent: "gemini", label: "g", createdAt: "t", importedAt: "t" }] }));
});

test("path helpers compose under the daemon dir", () => {
  assert.match(agentAccountsFile("/base"), /agent-accounts\.json$/);
  assert.equal(
    agentAccountHome("/base", "codex", "id9").endsWith("agent-accounts/codex/id9/home"),
    true
  );
});
