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

    assert.equal(scanner.feed(`\x1b${introducer}hidden\x07`), 0, introducer);
  }
});

test("BellScanner recovers after BEL terminates DCS, SOS, PM, and APC strings", () => {
  for (const introducer of ["P", "X", "^", "_"]) {
    const scanner = new BellScanner();

    assert.equal(scanner.feed(`\x1b${introducer}hidden\x07`), 0, introducer);
    assert.equal(scanner.feed("\x07"), 1, introducer);
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

test("ActivityTracker: output → working, bell sets attention, input clears it", () => {
  const tracker = new ActivityTracker();

  assert.deepEqual(tracker.snapshot(), { state: "idle", attention: null, lastOutputAt: null });

  tracker.noteOutput("hello", 10);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: null,
    lastOutputAt: new Date(10).toISOString()
  });

  tracker.noteOutput("\x07", 20);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: "bell",
    lastOutputAt: new Date(20).toISOString()
  });

  tracker.noteOutput("ordinary", 30);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: "bell",
    lastOutputAt: new Date(30).toISOString()
  });

  tracker.noteInput();
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: null,
    lastOutputAt: new Date(30).toISOString()
  });

  tracker.dispose();
});

test("ActivityTracker: structural hooks outrank byte-stream heuristics", () => {
  const changes: string[] = [];
  const tracker = new ActivityTracker((s, c) => changes.push(`${c}:${s.state}/${s.attention}`));

  tracker.noteOutput("hello", 10); // idle -> working
  tracker.applyHookEvent("waiting"); // -> waiting/needs-input
  tracker.noteOutput("repaint", 20); // must stay waiting; emits nothing
  tracker.noteInput(); // -> working, attention cleared
  tracker.applyHookEvent("done"); // -> idle/finished
  tracker.dispose();

  assert.deepEqual(changes, [
    "output:working/null",
    "hook:waiting/needs-input",
    "input:working/null",
    "hook:idle/finished"
  ]);
});

test("ActivityTracker: a bell never downgrades a structural attention", () => {
  const tracker = new ActivityTracker();

  tracker.applyHookEvent("waiting"); // waiting/needs-input
  tracker.noteOutput("\x07", 5); // bell arrives at the prompt
  assert.equal(tracker.snapshot().state, "waiting");
  assert.equal(tracker.snapshot().attention, "needs-input"); // not "bell"

  tracker.dispose();
});

test("ActivityTracker: noteHookSource latches coverage without a transition", () => {
  const changes: string[] = [];
  const tracker = new ActivityTracker((s, cause) => changes.push(`${cause}:${s.state}/${s.attention}`));

  assert.equal(tracker.hasHookSource, false);
  tracker.noteHookSource(); // e.g. a valid hook event that classifies to null
  assert.equal(tracker.hasHookSource, true);
  assert.deepEqual(changes, []); // no state change, no emission

  // A later bell still sets attention state (the dot pulses) — the push layer
  // is what demotes it, via hasHookSource on the lifecycle event.
  tracker.noteOutput("ding\x07", 1);
  assert.equal(tracker.snapshot().attention, "bell");
  assert.equal(tracker.hasHookSource, true);

  tracker.dispose();
});
