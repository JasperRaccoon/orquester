import { test } from "node:test";
import assert from "node:assert/strict";
import { readPlanWithoutStore } from "./context";

test("with no thread store, an intact plan is still its own markdown", async () => {
  assert.equal(
    await readPlanWithoutStore({ id: "plan-intact", planMarkdown: "# Ship it\n\nevery step" }),
    "# Ship it\n\nevery step"
  );
});

test("with no thread store, a truncated plan rejects rather than returning partial markdown", async () => {
  await assert.rejects(readPlanWithoutStore({
    id: "plan-cut",
    planMarkdown: "# Ship it\n\nstep 1…",
    truncated: true
  }));
});
