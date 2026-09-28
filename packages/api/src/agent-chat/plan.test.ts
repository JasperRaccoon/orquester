import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt, isPlanImplementationMessage } from "./plan.ts";

test("the implementation prompt is the prefix plus the trimmed plan", () => {
  assert.equal(buildPlanImplementationPrompt("  # Plan  "), "PLEASE IMPLEMENT THIS PLAN:\n# Plan");
});

test("isPlanImplementationMessage matches only the prefixed message", () => {
  assert.equal(isPlanImplementationMessage("PLEASE IMPLEMENT THIS PLAN:\nx"), true);
  assert.equal(isPlanImplementationMessage("please implement this plan"), false);
});
