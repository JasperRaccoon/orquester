import test from "node:test";
import assert from "node:assert/strict";

import { parseGptImageSettingsResponse } from "./validate.ts";

test("a settings answer is read, ignoring fields this client does not know", () => {
  assert.deepEqual(
    parseGptImageSettingsResponse({
      settings: { account: "acc-1", saveTo: { kind: "project", folder: "public/img", extra: 1 }, future: true },
      accounts: [
        { id: "acc-1", label: "work", email: "w@example.com", plan: "plus", tokenHint: "x" },
        { id: "acc-2", label: "free", email: null, plan: "free", blocked: "free-plan" }
      ],
      activeAccountId: "acc-1",
      apiKeyMode: "off"
    }),
    {
      settings: { account: "acc-1", saveTo: { kind: "project", folder: "public/img" } },
      accounts: [
        { id: "acc-1", label: "work", email: "w@example.com", plan: "plus" },
        { id: "acc-2", label: "free", email: null, plan: "free", blocked: "free-plan" }
      ],
      activeAccountId: "acc-1"
    }
  );
});

test("a broken envelope is no answer", () => {
  for (const bad of [null, "settings", [], { accounts: [] }, { settings: {}, accounts: "none" }, { settings: [], accounts: [] }]) {
    assert.equal(parseGptImageSettingsResponse(bad), null, JSON.stringify(bad));
  }
});

test("bad fields fall back to their defaults and unnamed accounts are left out", () => {
  assert.deepEqual(
    parseGptImageSettingsResponse({
      settings: { account: 7, saveTo: { kind: "project", folder: "" } },
      accounts: [{ label: "no id" }, "acc", { id: "acc-3", email: "e@example.com", blocked: "on-fire" }, { id: "acc-3", label: "dup" }],
      activeAccountId: 5
    }),
    {
      settings: { account: "auto", saveTo: { kind: "project", folder: "assets/generated" } },
      accounts: [{ id: "acc-3", label: "e@example.com", email: "e@example.com", plan: null }],
      activeAccountId: null
    }
  );
  assert.deepEqual(parseGptImageSettingsResponse({ settings: { saveTo: { kind: "somewhere" } }, accounts: [] })?.settings, {
    account: "auto",
    saveTo: { kind: "chat" }
  });
});
