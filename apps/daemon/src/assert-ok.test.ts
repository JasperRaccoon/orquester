/**
 * Pins scripts/test/assert-ok.mjs, which every package's test script preloads (AGENTS.md, "Tests and
 * fixtures"): a failing `assert.ok(value)` or `assert(value)` without a message fails at once and
 * names its own call. Without the preload, Node 20 looks the call up in the `.ts` file at the
 * position of tsx's one-line output — the wrong code, or a lookup that never ends.
 *
 * Every assert here that is meant to pass carries a message, and the failing ones run only once the
 * preload is known to be there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProxy } from "node:util/types";

const preloaded = isProxy(assert);

interface Row {
  payload?: unknown;
}

const rows: Row[] = [{ payload: {} }];
const flagged = (row: Row | undefined): boolean =>
  (row?.payload as Record<string, unknown> | undefined)?.["heldForUpdate"] === true;

function thrown(fn: () => void): Error & { generatedMessage?: boolean; actual?: unknown } {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

const falsy = (code: string): string => `The expression evaluated to a falsy value:\n\n  ${code}\n`;

it("the test script preloads scripts/test/assert-ok.mjs", () => {
  assert.equal(preloaded, true, "node:assert/strict is not the one scripts/test/assert-ok-hooks.mjs serves");
});

describe("a failing assert without a message", { skip: !preloaded }, () => {
  it("names its own call, TypeScript and all", () => {
    const error = thrown(() => assert.ok(flagged(rows[0])));
    assert.equal(error.message, falsy("assert.ok(flagged(rows[0]))"), "message");
    assert.equal(error instanceof assert.AssertionError, true, "an AssertionError");
    assert.equal(error.generatedMessage, true, "generatedMessage");
    assert.equal(error.actual, false, "actual");
    const frame = error.stack?.split("\n").find((line) => line.startsWith("    at "));
    assert.match(frame ?? "", /assert-ok\.test\.ts:\d+:\d+\)?$/, "the stack starts at the call");
  });

  it("quotes a call over several lines as Node does", () => {
    const error = thrown(() =>
      assert.ok(
        rows.some((row) => (row.payload as { x?: number } | undefined)?.x === 1)
      )
    );
    assert.equal(
      error.message,
      falsy("assert.ok(\n    rows.some((row) => (row.payload as { x?: number } | undefined)?.x === 1)\n  )"),
      "message"
    );
  });

  it("covers a direct call of the default export", () => {
    assert.equal(thrown(() => assert(rows.length === 2)).message, falsy("assert(rows.length === 2)"), "message");
  });

  it("leaves a given message, an Error and a missing value to Node's rules", () => {
    assert.equal(thrown(() => assert.ok(0, "the words given")).message, "the words given", "message kept");
    const error = new TypeError("thrown as is");
    assert.equal(thrown(() => assert.ok(null, error)), error, "an Error message is thrown");
    assert.equal(
      thrown(() => (assert.ok as () => void)()).message,
      "No value argument passed to `assert.ok()`",
      "no value"
    );
  });
});
