import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX, buildPlanImplementationPrompt, isPlanImplementationMessage } from "./plan.ts";

test("the implementation prompt is the prefix plus the trimmed plan", () => {
  assert.equal(buildPlanImplementationPrompt("  # Plan  "), `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`);
  assert.equal(PLAN_IMPLEMENTATION_PROMPT_PREFIX, "PLEASE IMPLEMENT THIS PLAN:\n");
});

test("isPlanImplementationMessage matches only the prefixed message", () => {
  assert.equal(isPlanImplementationMessage(buildPlanImplementationPrompt("x")), true);
  assert.equal(isPlanImplementationMessage("please implement this plan"), false);
});
