/**
 * The host-parsed `/goal` (goals §5.1): the table every Codex `/goal …` is
 * decided by before anything is committed. Codex's own TUI grammar
 * (`/goal [<objective>|clear|edit|pause|resume]`, subcommands matched on the
 * WHOLE argument, case-insensitively) plus the two host bounds — an objective
 * of 1–4000 characters and no attachments.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AttachmentRef } from "@orquester/api/agent-chat";

import { MAX_GOAL_OBJECTIVE_CHARS, parseHostGoalCommand } from "./slash.ts";

const file: AttachmentRef = { type: "file", id: "a1", name: "notes.txt", sizeBytes: 3 };
const image: AttachmentRef = {
  type: "image",
  id: "a2",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 10
};

describe("parseHostGoalCommand (goals §5.1)", () => {
  it("is not a goal command unless the trimmed text is /goal followed by a boundary", () => {
    for (const text of [
      "",
      "goal fix it",
      "/goals",
      "/goals list",
      "/goalie",
      "/go al",
      "//goal x",
      "please /goal x",
      "/compact",
      "/goal-setting"
    ]) {
      assert.equal(parseHostGoalCommand(text), null, JSON.stringify(text));
    }
  });

  it("a bare /goal and `status` both ask for the status, in any case", () => {
    for (const text of ["/goal", "  /goal  ", "/GOAL", "/Goal status", "/goal STATUS", "/goal\tstatus  "]) {
      assert.deepEqual(parseHostGoalCommand(text), { kind: "status" }, JSON.stringify(text));
    }
  });

  it("pause, resume and clear match the WHOLE argument, case-insensitively", () => {
    assert.deepEqual(parseHostGoalCommand("/goal pause"), { kind: "pause" });
    assert.deepEqual(parseHostGoalCommand("/goal Pause"), { kind: "pause" });
    assert.deepEqual(parseHostGoalCommand("/goal RESUME"), { kind: "resume" });
    assert.deepEqual(parseHostGoalCommand("/goal resume"), { kind: "resume" });
    assert.deepEqual(parseHostGoalCommand("/goal clear"), { kind: "clear" });
    assert.deepEqual(parseHostGoalCommand("/GOAL  cLeAr  "), { kind: "clear" });
    // An objective that merely STARTS with a subcommand's word is an objective.
    assert.deepEqual(parseHostGoalCommand("/goal pause the deploy until Monday"), {
      kind: "set",
      objective: "pause the deploy until Monday"
    });
    assert.deepEqual(parseHostGoalCommand("/goal clearer error messages"), {
      kind: "set",
      objective: "clearer error messages"
    });
    assert.deepEqual(parseHostGoalCommand("/goal status page for the API"), {
      kind: "set",
      objective: "status page for the API"
    });
  });

  it("edit takes an objective, and without one is a usage error", () => {
    assert.deepEqual(parseHostGoalCommand("/goal edit ship v2 by Friday"), {
      kind: "edit",
      objective: "ship v2 by Friday"
    });
    assert.deepEqual(parseHostGoalCommand("/goal EDIT   ship it  "), {
      kind: "edit",
      objective: "ship it"
    });
    assert.deepEqual(parseHostGoalCommand("/goal edit\nship it"), { kind: "edit", objective: "ship it" });
    assert.deepEqual(parseHostGoalCommand("/goal edit"), { error: "Usage: /goal edit <objective>" });
    assert.deepEqual(parseHostGoalCommand("/goal Edit   "), { error: "Usage: /goal edit <objective>" });
    // `edit` is a word, not a prefix.
    assert.deepEqual(parseHostGoalCommand("/goal editorial pass on the docs"), {
      kind: "set",
      objective: "editorial pass on the docs"
    });
  });

  it("anything else sets a goal with that objective — trimmed, otherwise verbatim", () => {
    assert.deepEqual(parseHostGoalCommand("/goal   make the build green  "), {
      kind: "set",
      objective: "make the build green"
    });
    assert.deepEqual(parseHostGoalCommand("/GOAL Ship It"), { kind: "set", objective: "Ship It" });
    assert.deepEqual(parseHostGoalCommand("/goal\nfix the flaky test\nand keep CI green"), {
      kind: "set",
      objective: "fix the flaky test\nand keep CI green"
    });
  });

  it("an objective is 1–4000 characters after trimming", () => {
    assert.equal(MAX_GOAL_OBJECTIVE_CHARS, 4_000);
    const exact = "x".repeat(4_000);
    assert.deepEqual(parseHostGoalCommand(`/goal ${exact}`), { kind: "set", objective: exact });
    assert.deepEqual(parseHostGoalCommand(`/goal ${exact}   `), { kind: "set", objective: exact });
    assert.deepEqual(parseHostGoalCommand(`/goal ${exact}x`), {
      error: "A goal is limited to 4000 characters."
    });
    assert.deepEqual(parseHostGoalCommand(`/goal edit ${exact}`), { kind: "edit", objective: exact });
    assert.deepEqual(parseHostGoalCommand(`/goal edit ${exact}x`), {
      error: "A goal is limited to 4000 characters."
    });
  });

  it("counts characters the way Codex does — code points, not UTF-16 units", () => {
    // Codex validates `objective.chars().count() <= 4000`; 4000 astral-plane
    // characters are 8000 UTF-16 units and must still be accepted, or the host
    // would refuse an objective the provider takes.
    const astral = "🎯".repeat(4_000);
    assert.deepEqual(parseHostGoalCommand(`/goal ${astral}`), { kind: "set", objective: astral });
    assert.deepEqual(parseHostGoalCommand(`/goal ${astral}🎯`), {
      error: "A goal is limited to 4000 characters."
    });
  });

  it("refuses attachments with every goal command", () => {
    for (const text of ["/goal", "/goal status", "/goal pause", "/goal ship it", "/goal edit ship it"]) {
      assert.deepEqual(
        parseHostGoalCommand(text, [file]),
        { error: "A goal can't include attachments." },
        text
      );
    }
    assert.deepEqual(parseHostGoalCommand("/goal ship it", [image]), {
      error: "A goal can't include attachments."
    });
    // Attachments on anything that is not a goal command are not this
    // parser's business, and an empty list is no attachment at all.
    assert.equal(parseHostGoalCommand("/goals", [file]), null);
    assert.equal(parseHostGoalCommand("look at this", [file]), null);
    assert.deepEqual(parseHostGoalCommand("/goal ship it", []), { kind: "set", objective: "ship it" });
  });
});
