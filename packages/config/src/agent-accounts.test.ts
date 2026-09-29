import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentAccounts } from "./index.ts";

test("parseAgentAccounts fills defaults and coerces missing fields", () => {
  const parsed = parseAgentAccounts({
    accounts: [{ id: "a1", agent: "claude", label: "Work", createdAt: "t", importedAt: "t" }]
  });
  assert.equal(parsed.accounts[0].email, null);
  assert.equal(parsed.accounts[0].plan, null);
  assert.equal(parsed.accounts[0].needsReauth, false);
  assert.deepEqual(parsed.defaults, { claude: null, codex: null, grok: null });
});

test("parseAgentAccounts rejects an unknown agent", () => {
  assert.throws(() => parseAgentAccounts({ accounts: [{ id: "x", agent: "gemini", label: "g", createdAt: "t", importedAt: "t" }] }));
});
