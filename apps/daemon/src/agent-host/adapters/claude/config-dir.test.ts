/**
 * The one answer to "where does this Claude CLI child keep its config and
 * transcripts": the probe's cache key, the per-cwd skills overlay and the goal
 * transcript reader all ask it (goals §6.1.4).
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import { claudeConfigDir } from "./config-dir.ts";

describe("claude config dir", () => {
  it("is the child env's CLAUDE_CONFIG_DIR — a managed account's home", () => {
    assert.equal(
      claudeConfigDir({ CLAUDE_CONFIG_DIR: "/homes/acc-1/home", HOME: "/elsewhere" }),
      "/homes/acc-1/home"
    );
  });

  it("falls back to the host user's ~/.claude, never to a HOME the env names", () => {
    // `HOME` is the daemon user's own in every child env (`support/env.ts`),
    // so the host's `homedir()` is the same directory — and it is what the
    // probe has always keyed its cache on.
    assert.equal(claudeConfigDir({ HOME: "/somewhere/else" }), nodePath.join(homedir(), ".claude"));
    assert.equal(claudeConfigDir({}), nodePath.join(homedir(), ".claude"));
  });
});
