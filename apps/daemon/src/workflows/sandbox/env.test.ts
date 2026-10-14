import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { appendNodeRequireOption } from "@orquester/config";

import { setSessionNodePreload } from "../../plugins/session-env.ts";
import { buildSandboxEnv } from "./env.ts";

const PRELOAD = "/srv/orq/daemon/plugins/ts-rust/preload.cjs";

function sandboxEnv(env: Record<string, string> = {}): Record<string, string> {
  return buildSandboxEnv({ runId: "run-1", workflowId: "wf-1", env, tmpDir: "/srv/orq/tmp" });
}

afterEach(() => {
  setSessionNodePreload(null);
});

test("no preload active: NODE_OPTIONS is the block's own, or absent", () => {
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--no-deprecation";
  try {
    assert.equal("NODE_OPTIONS" in sandboxEnv(), false, "the daemon's NODE_OPTIONS is never inherited");
    assert.equal(sandboxEnv({ NODE_OPTIONS: "--no-warnings" }).NODE_OPTIONS, "--no-warnings");
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

test("a preload active: required alone, or appended after the block's NODE_OPTIONS", () => {
  setSessionNodePreload(PRELOAD);
  assert.equal(sandboxEnv().NODE_OPTIONS, appendNodeRequireOption(undefined, PRELOAD));
  assert.equal(sandboxEnv({ NODE_OPTIONS: "--no-warnings" }).NODE_OPTIONS, `--no-warnings --require ${JSON.stringify(PRELOAD)}`);
});
