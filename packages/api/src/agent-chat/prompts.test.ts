import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlanImplementationPrompt } from "./plan.ts";
import { isProviderInternalUserText, recallablePromptText } from "./prompts.ts";

describe("recallablePromptText", () => {
  it("keeps what the user typed, trimmed", () => {
    assert.equal(recallablePromptText("  fix the login bug \n"), "fix the login bug");
  });

  it("drops the rows a provider's transcript wrote itself", () => {
    for (const text of [
      "<command-name>/clear</command-name>",
      "  <task-notification>done</task-notification>",
      "<local-command-stdout>ok</local-command-stdout>",
      "<system-reminder>x</system-reminder>",
      "<local-command-caveat>y</local-command-caveat>"
    ]) {
      assert.equal(isProviderInternalUserText(text), true, text);
      assert.equal(recallablePromptText(text), null, text);
    }
  });

  it("drops the verbatim /compact and the plan's Implement prompt", () => {
    assert.equal(recallablePromptText(" /COMPACT "), null);
    assert.equal(recallablePromptText(buildPlanImplementationPrompt("# Plan\n- a")), null);
  });

  it("removes image placeholders with the space before them", () => {
    assert.equal(recallablePromptText("this one [Image #1] and [Image #2] too"), "this one and too");
    assert.equal(recallablePromptText("[Image #1] explain"), "explain");
  });

  it("drops a message that was only images or whitespace", () => {
    assert.equal(recallablePromptText("[Image #1] [Image #2]"), null);
    assert.equal(recallablePromptText("   "), null);
  });

  it("keeps a slash command the user typed", () => {
    assert.equal(recallablePromptText("/goal pause"), "/goal pause");
  });
});
