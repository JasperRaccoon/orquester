import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, BellScanner, IDLE_MS } from "./ansi-activity.ts";

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

test("BellScanner reports the last OSC 0/2 title of each chunk", () => {
  const scanner = new BellScanner();

  scanner.feed("\x1b]0;first\x07 text \x1b]2;second\x1b\\");
  assert.equal(scanner.chunkTitle, "second");

  // A chunk with no title clears the per-chunk report.
  scanner.feed("plain output");
  assert.equal(scanner.chunkTitle, null);

  // Non-title OSCs (here OSC 8, hyperlinks) are not titles.
  scanner.feed("\x1b]8;;https://example.com\x07");
  assert.equal(scanner.chunkTitle, null);

  // An empty title is a title ("" is what a shell sets to clear it).
  scanner.feed("\x1b]2;\x07");
  assert.equal(scanner.chunkTitle, "");
});

test("BellScanner reports a chunk-split title once, in the terminating chunk", () => {
  const scanner = new BellScanner();

  assert.equal(scanner.feed("\x1b]0;split ti"), 0);
  assert.equal(scanner.chunkTitle, null);
  assert.equal(scanner.feed("tle\x07"), 0);
  assert.equal(scanner.chunkTitle, "split title");
});

test("BellScanner counts OSC 9 / OSC 777 notifications as bells", () => {
  const scanner = new BellScanner();

  // The notification's own terminating BEL is consumed by the string state, so
  // the sequence itself has to ring — otherwise these vanish entirely.
  assert.equal(scanner.feed("\x1b]9;build finished\x07"), 1);
  assert.equal(scanner.feed("\x1b]777;notify;title;body\x07"), 1);
  // ST-terminated is the same notification.
  assert.equal(scanner.feed("\x1b]9;done\x1b\\"), 1);
  // Titles and other OSCs stay silent.
  assert.equal(scanner.feed("\x1b]0;title\x07"), 0);
  assert.equal(scanner.chunkTitle, "title");
  assert.equal(scanner.feed("\x1b]2;title\x1b\\"), 0);
  assert.equal(scanner.feed("\x1b]8;;https://example.com\x07"), 0);
  // A notification split across chunks rings once, in the terminating chunk.
  assert.equal(scanner.feed("\x1b]9;half"), 0);
  assert.equal(scanner.feed(" done\x07"), 1);
});

test("ActivityTracker: an OSC 9 notification raises attention", () => {
  const tracker = new ActivityTracker();

  tracker.noteOutput("\x1b]777;notify;Claude;your turn\x07", 10);
  assert.equal(tracker.snapshot().attention, "bell");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(10).toISOString());

  tracker.dispose();
});

test("ActivityTracker: output → working, bell sets attention, input clears it", () => {
  const tracker = new ActivityTracker();

  assert.deepEqual(tracker.snapshot(), {
    state: "idle",
    attention: null,
    lastOutputAt: null,
    needsAttentionAt: null
  });

  tracker.noteOutput("hello", 10);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: null,
    lastOutputAt: new Date(10).toISOString(),
    needsAttentionAt: null
  });

  tracker.noteOutput("\x07", 20);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: "bell",
    lastOutputAt: new Date(20).toISOString(),
    needsAttentionAt: new Date(20).toISOString()
  });

  tracker.noteOutput("ordinary", 30);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: "bell",
    lastOutputAt: new Date(30).toISOString(),
    needsAttentionAt: new Date(20).toISOString()
  });

  tracker.noteInput(40);
  assert.deepEqual(tracker.snapshot(), {
    state: "working",
    attention: null,
    lastOutputAt: new Date(30).toISOString(),
    needsAttentionAt: null
  });

  tracker.dispose();
});

test("ActivityTracker: needsAttentionAt tracks structural attention too", () => {
  const tracker = new ActivityTracker();

  tracker.applyHookEvent("waiting", 100);
  assert.equal(tracker.snapshot().attention, "needs-input");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(100).toISOString());

  // A repeat of the same class must not re-stamp the timestamp.
  tracker.applyHookEvent("waiting", 200);
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(100).toISOString());

  tracker.applyHookEvent("done", 300);
  assert.equal(tracker.snapshot().attention, "finished");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(300).toISOString());

  tracker.applyHookEvent("working", 400);
  assert.equal(tracker.snapshot().attention, null);
  assert.equal(tracker.snapshot().needsAttentionAt, null);

  tracker.dispose();
});

test("ActivityTracker: output echoing local input is neither heartbeat nor bell", () => {
  const changes: string[] = [];
  const tracker = new ActivityTracker((s, cause) => changes.push(`${cause}:${s.state}/${s.attention}`));

  tracker.noteInput(1_000);
  // Well inside INPUT_ECHO_GRACE_MS (1500): the terminal echoing the keystroke,
  // plus a readline beep, is not the session working or asking for anything.
  tracker.noteOutput("ls\x07", 1_200);
  assert.deepEqual(tracker.snapshot(), {
    state: "idle",
    attention: null,
    lastOutputAt: new Date(1_200).toISOString(),
    needsAttentionAt: null
  });
  assert.deepEqual(changes, []);

  // Past the grace window the same bytes count for real.
  tracker.noteOutput("output\x07", 3_000);
  assert.equal(tracker.snapshot().state, "working");
  assert.equal(tracker.snapshot().attention, "bell");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(3_000).toISOString());

  tracker.dispose();
});

test("ActivityTracker: typing during a live stream cannot make the session read idle", () => {
  // Real (mocked) timers, so a heartbeat that never rearms the idle timer is
  // observable as the session actually falling to idle.
  mock.timers.enable({ apis: ["setTimeout"] });
  const tracker = new ActivityTracker();
  try {
    // Output every 200ms with a keystroke every 300ms: every chunk lands inside
    // INPUT_ECHO_GRACE_MS of an input, but the session is streaming real work
    // and must keep its heartbeats (the echo window only blocks a wake-up).
    tracker.noteOutput("streaming", 0);
    assert.equal(tracker.snapshot().state, "working");
    for (let t = 100; t <= 10_000; t += 100) {
      mock.timers.tick(100);
      if (t % 200 === 0) {
        tracker.noteOutput(`chunk ${t}`, t);
      }
      if (t % 300 === 0) {
        tracker.noteInput(t);
      }
      assert.equal(tracker.snapshot().state, "working", `t=${t}`);
    }
    assert.equal(tracker.snapshot().lastOutputAt, new Date(10_000).toISOString());

    // The stream stops (the user keeps typing): now the session is allowed to
    // go quiet, and typing alone must not resurrect it.
    mock.timers.tick(IDLE_MS + 100);
    assert.equal(tracker.snapshot().state, "idle");
    tracker.noteInput(13_150);
    tracker.noteOutput("echo", 13_200);
    assert.equal(tracker.snapshot().state, "idle", "echo of a keystroke is not work");
  } finally {
    tracker.dispose();
    mock.timers.reset();
  }
});

test("ActivityTracker: a bell 400ms after a keystroke still raises attention", () => {
  const tracker = new ActivityTracker();

  // Only the terminal's own beep is simultaneous with the echo; an agent
  // ringing to ask a question lands later and must survive the window.
  tracker.noteInput(1_000);
  tracker.noteOutput("\x07", 1_400);
  assert.equal(tracker.snapshot().attention, "bell");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(1_400).toISOString());

  tracker.dispose();
});

test("ActivityTracker: a programmatic write opens no echo window", () => {
  const tracker = new ActivityTracker();

  // The MCP tools write, then wait for the bell that answers them — their own
  // write must not suppress it (I-4: sendAndWait blocked until its timeout).
  tracker.noteInput(1_000, { programmatic: true });
  tracker.noteOutput("\x07", 1_050);
  assert.equal(tracker.snapshot().attention, "bell");
  assert.equal(tracker.snapshot().needsAttentionAt, new Date(1_050).toISOString());

  // The same timing from a real keystroke IS the terminal's own beep.
  const typed = new ActivityTracker();
  typed.noteInput(1_000);
  typed.noteOutput("\x07", 1_050);
  assert.equal(typed.snapshot().attention, null);

  tracker.dispose();
  typed.dispose();
});

test("ActivityTracker: exit raises finished attention", () => {
  const changes: string[] = [];
  const tracker = new ActivityTracker((s, cause) => changes.push(`${cause}:${s.state}/${s.attention}`));

  tracker.noteOutput("working", 10);
  tracker.noteExit(50);
  assert.deepEqual(tracker.snapshot(), {
    state: "idle",
    attention: "finished",
    lastOutputAt: new Date(10).toISOString(),
    needsAttentionAt: new Date(50).toISOString()
  });
  assert.deepEqual(changes, ["output:working/null", "exit:idle/finished"]);

  // An agent that already reported "done" via a hook is already at the same
  // state — the exit must not re-stamp or re-emit.
  const hooked = new ActivityTracker((s, cause) => changes.push(`${cause}:${s.state}/${s.attention}`));
  hooked.applyHookEvent("done", 100);
  hooked.noteExit(200);
  assert.equal(hooked.snapshot().needsAttentionAt, new Date(100).toISOString());
  assert.deepEqual(changes.slice(2), ["hook:idle/finished"]);

  tracker.dispose();
  hooked.dispose();
});

test("ActivityTracker: a title streak makes only title changes count as heartbeats", () => {
  const tracker = new ActivityTracker();

  // Two title changes inside TITLE_STREAK_WINDOW_MS (3000) → title-driven.
  tracker.noteOutput("\x1b]0;spin -\x07", 0);
  tracker.noteOutput("\x1b]0;spin \\\x07", 500);
  // Park the session at idle without waiting out the timer.
  tracker.applyHookEvent("done", 600);
  assert.equal(tracker.snapshot().state, "idle");

  // Raw repaint bytes are no longer a heartbeat for a title-driven session.
  tracker.noteOutput("\x1b[2K\r frame ", 700);
  assert.equal(tracker.snapshot().state, "idle");

  // A title CHANGE still is.
  tracker.noteOutput("\x1b]0;spin |\x07", 800);
  assert.equal(tracker.snapshot().state, "working");

  tracker.dispose();
});

test("ActivityTracker: a one-off retitle does not make a session title-driven", () => {
  const tracker = new ActivityTracker();

  // A single shell-prompt retitle (streak 1) leaves raw bytes as heartbeats...
  tracker.noteOutput("\x1b]0;~/project\x07", 0);
  tracker.applyHookEvent("done", 100);
  tracker.noteOutput("plain bytes", 200);
  assert.equal(tracker.snapshot().state, "working");

  // ...and so does a streak whose last title change has aged out of the window.
  tracker.noteOutput("\x1b]0;a\x07", 300);
  tracker.noteOutput("\x1b]0;b\x07", 400); // streak 2 → title-driven at t≈400
  tracker.applyHookEvent("done", 500);
  tracker.noteOutput("plain bytes", 4_000); // 3600ms later: streak expired
  assert.equal(tracker.snapshot().state, "working");

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
