import test from "node:test";
import assert from "node:assert/strict";

import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
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

test("replaceTextRange splices and reports the caret after the replacement", () => {
  const text = "a @sr b";
  const replacement = "@src/index.ts ";
  const end = extendReplacementRangeForTrailingSpace(text, 5, replacement);
  assert.deepEqual(replaceTextRange(text, 2, end, replacement), {
    text: "a @src/index.ts b",
    cursor: 16
  });
});
