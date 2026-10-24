import assert from "node:assert/strict";
import { test } from "node:test";

import { resetAfterQueuedWrites } from "./terminal-reset";

/** xterm's write model: writes queue and are parsed later, in order, each followed by its callback. */
class FakeTerminal {
  screen = "";
  private queue: Array<{ data: string; callback?: () => void }> = [];
  write(data: string, callback?: () => void): void {
    this.queue.push({ data, callback });
  }
  reset(): void {
    this.screen = "";
  }
  parse(): void {
    for (const { data, callback } of this.queue.splice(0)) {
      this.screen += data;
      callback?.();
    }
  }
}

test("a reset lands after data already queued and before the replay that follows", () => {
  const term = new FakeTerminal();
  term.write("SNAPSHOT 1\n"); // still queued when the daemon's reset arrives
  resetAfterQueuedWrites(term);
  term.write("SNAPSHOT 2\n");
  term.parse();
  assert.equal(term.screen, "SNAPSHOT 2\n");
});

test("an immediate reset would have let the queued snapshot through (the bug)", () => {
  const term = new FakeTerminal();
  term.write("SNAPSHOT 1\n");
  term.reset();
  term.write("SNAPSHOT 2\n");
  term.parse();
  assert.equal(term.screen, "SNAPSHOT 1\nSNAPSHOT 2\n");
});
