import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, BellScanner } from "./ansi-activity.ts";

test("BellScanner counts BEL in ground state", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("ready\x07"), 1);
  assert.equal(scanner.feed("more\x07again\x07"), 2);
});

test("BellScanner ignores OSC terminator BEL and counts a later ground BEL", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("a\x1b]0;title\x07b\x07"), 1);
});

test("BellScanner ignores OSC content terminated by ST and counts trailing ground BEL", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("\x1b]2;title\x1b\\\x07"), 1);
});

test("BellScanner recognizes C1 ST after C1 string introducers", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("\x9d0;title\x9c\x07"), 1);
});

test("BellScanner swallows BELs inside DCS, SOS, PM, and APC strings", () => {
  for (const introducer of ["P", "X", "^", "_"]) {
    const scanner = new BellScanner();

    assert.equal(scanner.feed(`\x1b${introducer}hidden\x07still-hidden\x07\x1b\\shown\x07`), 1, introducer);
  }
});

test("BellScanner returns to ground after CSI final byte so the following BEL counts", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("\x1b[31m\x07"), 1);
});

test("BellScanner keeps escape and string state across chunk boundaries", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("\x1b]0;ti"), 0);
  assert.equal(scanner.feed("tle\x07"), 0);
  assert.equal(scanner.feed("\x07"), 1);

  const stScanner = new BellScanner();
  assert.equal(stScanner.feed("\x1bPpayload\x07\x1b"), 0);
  assert.equal(stScanner.feed("\\\x07"), 1);
});

test("ActivityTracker records output and only input clears bell attention", () => {
  const tracker = new ActivityTracker();

  assert.deepEqual(tracker.snapshot(), { lastOutputAt: null, attention: false });
  assert.equal(tracker.onOutput("hello", 10), false);
  assert.deepEqual(tracker.snapshot(), { lastOutputAt: 10, attention: false });

  assert.equal(tracker.onOutput("\x07", 20), true);
  assert.deepEqual(tracker.snapshot(), { lastOutputAt: 20, attention: true });

  assert.equal(tracker.onOutput("ordinary", 30), false);
  assert.deepEqual(tracker.snapshot(), { lastOutputAt: 30, attention: true });

  tracker.onInput();
  assert.deepEqual(tracker.snapshot(), { lastOutputAt: 30, attention: false });
});
