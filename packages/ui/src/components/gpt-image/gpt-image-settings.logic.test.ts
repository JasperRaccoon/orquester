import test from "node:test";
import assert from "node:assert/strict";

import type { GptImageSettingsResponse } from "@orquester/api";

import {
  gptImageAccountOptions,
  gptImageFolderProblem,
  gptImageQuotaAccountId,
  gptImageSettingsForm,
  gptImageSettingsPatch
} from "./gpt-image-settings.logic.ts";

function response(overrides: Partial<GptImageSettingsResponse> = {}): GptImageSettingsResponse {
  return {
    settings: { account: "auto", saveTo: { kind: "chat" } },
    accounts: [
      { id: "a", label: "a@example.com", email: "a@example.com", plan: "free", blocked: "free-plan" },
      { id: "b", label: "work", email: "b@example.com", plan: "plus" }
    ],
    activeAccountId: "b",
    ...overrides
  };
}

test("account choices: Auto first, then each account in order, marking the one in use", () => {
  const options = gptImageAccountOptions(response());
  assert.deepEqual(
    options.map((o) => [o.value, o.plan, o.blocked, o.active]),
    [
      ["auto", null, null, false],
      ["a", "Free", "free-plan", false],
      ["b", "Plus", null, true]
    ]
  );
});

test("a chosen account that is no longer connected stays a choice, so the saved value shows", () => {
  const options = gptImageAccountOptions(response({ settings: { account: "gone", saveTo: { kind: "chat" } } }));
  assert.deepEqual(options.at(-1)?.value, "gone");
  assert.equal(options.at(-1)?.missing, true);
});

test("project folders must stay relative and inside the project", () => {
  for (const ok of ["assets/generated", "./public/img/", "docs\\images"]) assert.equal(gptImageFolderProblem(ok), null, ok);
  for (const bad of ["", "  ", ".", "/etc", "~/pics", "C:\\pics", "../outside", "assets/../../x"]) {
    assert.notEqual(gptImageFolderProblem(bad), null, bad);
  }
});

test("Save sends only what changed, with the folder normalised", () => {
  const saved = response().settings;
  assert.deepEqual(gptImageSettingsPatch(saved, gptImageSettingsForm(saved)), { patch: {} });
  // Switching to the project keeps the default folder the form shows.
  assert.deepEqual(gptImageSettingsPatch(saved, { ...gptImageSettingsForm(saved), saveKind: "project" }), {
    patch: { saveTo: { kind: "project", folder: "assets/generated" } }
  });
  assert.deepEqual(gptImageSettingsPatch(saved, { account: "b", saveKind: "project", folder: " ./img/ " }), {
    patch: { account: "b", saveTo: { kind: "project", folder: "img" } }
  });
  const inProject = { account: "auto", saveTo: { kind: "project" as const, folder: "img" } };
  assert.deepEqual(gptImageSettingsPatch(inProject, { account: "auto", saveKind: "project", folder: "img/" }), { patch: {} });
  assert.deepEqual(gptImageSettingsPatch(inProject, { account: "auto", saveKind: "chat", folder: "img" }), {
    patch: { saveTo: { kind: "chat" } }
  });
  assert.ok("error" in gptImageSettingsPatch(saved, { account: "auto", saveKind: "project", folder: "../x" }));
});

test("the quota shown is the account in use, else the chosen connected one, else none", () => {
  assert.equal(gptImageQuotaAccountId(response()), "b");
  assert.equal(
    gptImageQuotaAccountId(response({ activeAccountId: null, settings: { account: "a", saveTo: { kind: "chat" } } })),
    "a"
  );
  assert.equal(gptImageQuotaAccountId(response({ activeAccountId: null })), null);
  assert.equal(
    gptImageQuotaAccountId(response({ activeAccountId: null, settings: { account: "gone", saveTo: { kind: "chat" } } })),
    null
  );
});
