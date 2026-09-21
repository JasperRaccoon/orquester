import test from "node:test";
import assert from "node:assert/strict";

import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  isStandaloneCompactCommand,
  isTriggerAtPromptStart,
  parseStandaloneComposerSlashCommand,
  replaceTextRange
} from "./composer-trigger.ts";

test("slash opens the command menu only at the start of a line", () => {
  assert.deepEqual(detectComposerTrigger("/mod", 4), {
    kind: "slash-command",
    query: "mod",
    rangeStart: 0,
    rangeEnd: 4
  });
  // Second line, still a line start.
  assert.deepEqual(detectComposerTrigger("hello\n/pl", 9), {
    kind: "slash-command",
    query: "pl",
    rangeStart: 6,
    rangeEnd: 9
  });
  // Mid-line: a path, a date or a regex — never a command menu.
  assert.equal(detectComposerTrigger("see src/lib", 11), null);
});

test("a slash trigger dies as soon as the token contains whitespace", () => {
  assert.equal(detectComposerTrigger("/plan now", 9), null);
});

test("the bare slash itself is a trigger with an empty query", () => {
  assert.deepEqual(detectComposerTrigger("/", 1), {
    kind: "slash-command",
    query: "",
    rangeStart: 0,
    rangeEnd: 1
  });
});

test("any currency symbol starts a skill token, not just $", () => {
  assert.deepEqual(detectComposerTrigger("run $brainstorm", 15), {
    kind: "skill",
    query: "brainstorm",
    rangeStart: 4,
    rangeEnd: 15
  });
  assert.deepEqual(detectComposerTrigger("€rev", 4), {
    kind: "skill",
    query: "rev",
    rangeStart: 0,
    rangeEnd: 4
  });
});

test("@ starts a path token on the current whitespace-delimited word", () => {
  assert.deepEqual(detectComposerTrigger("look at @src/ind", 16), {
    kind: "path",
    query: "src/ind",
    rangeStart: 8,
    rangeEnd: 16
  });
});

test("a caret before the trigger character sees no trigger", () => {
  assert.equal(detectComposerTrigger("@src", 0), null);
});

test("the cursor is clamped, so a stale caret cannot read out of range", () => {
  assert.deepEqual(detectComposerTrigger("/go", 999), {
    kind: "slash-command",
    query: "go",
    rangeStart: 0,
    rangeEnd: 3
  });
  assert.equal(detectComposerTrigger("/go", -5), null);
  assert.deepEqual(detectComposerTrigger("/go", Number.NaN), {
    kind: "slash-command",
    query: "go",
    rangeStart: 0,
    rangeEnd: 3
  });
});

test("the position gate keys on offset 0, not on the line", () => {
  const first = detectComposerTrigger("/pl", 3);
  const second = detectComposerTrigger("hi\n/pl", 6);
  assert.ok(first && second);
  assert.equal(isTriggerAtPromptStart(first), true);
  // A line start that is not the message start: provider commands get filtered.
  assert.equal(isTriggerAtPromptStart(second), false);
});

test("replaceTextRange splices and reports the caret after the replacement", () => {
  assert.deepEqual(replaceTextRange("a @sr b", 2, 5, "@src/index.ts "), {
    text: "a @src/index.ts  b",
    cursor: 16
  });
});

test("replaceTextRange clamps an inverted or out-of-range span", () => {
  assert.deepEqual(replaceTextRange("abc", 9, 2, "X"), { text: "abcX", cursor: 4 });
});

test("a trailing space in the replacement swallows one space already there", () => {
  assert.equal(extendReplacementRangeForTrailingSpace("/pl rest", 3, "/plan "), 4);
  assert.equal(extendReplacementRangeForTrailingSpace("/pl", 3, "/plan "), 3);
  // No trailing space in the replacement: never extend.
  assert.equal(extendReplacementRangeForTrailingSpace("/pl rest", 3, "/plan"), 3);
});

test("/plan and /default are re-recognised on submit, case-insensitively", () => {
  assert.equal(parseStandaloneComposerSlashCommand("/plan"), "plan");
  assert.equal(parseStandaloneComposerSlashCommand("  /Default  "), "default");
  assert.equal(parseStandaloneComposerSlashCommand("/plan the work"), null);
  // §4.6.5(a): /model and /effort are deliberately NOT recognised on submit.
  assert.equal(parseStandaloneComposerSlashCommand("/model"), null);
  assert.equal(parseStandaloneComposerSlashCommand("/effort"), null);
});

test("the compact predicate is exact, trimmed and lowercased", () => {
  assert.equal(isStandaloneCompactCommand("  /COMPACT "), true);
  assert.equal(isStandaloneCompactCommand("/compact now"), false);
  assert.equal(isStandaloneCompactCommand("compact"), false);
});
