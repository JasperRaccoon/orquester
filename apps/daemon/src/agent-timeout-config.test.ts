import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultAppConfig, parseAppConfig } from "@orquester/config";

test("a config with no agents group defaults to 30 minutes", () => {
  assert.equal(createDefaultAppConfig().agents.claudeTimeoutMinutes, 30);
  assert.equal(parseAppConfig({}).agents.claudeTimeoutMinutes, 30);
});

test("an explicit in-range value is preserved", () => {
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 10 } }).agents.claudeTimeoutMinutes, 10);
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 1 } }).agents.claudeTimeoutMinutes, 1);
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 30 } }).agents.claudeTimeoutMinutes, 30);
});

test("out-of-range and non-integer values are rejected", () => {
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 0 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 31 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 2.5 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: "30" } }));
});
