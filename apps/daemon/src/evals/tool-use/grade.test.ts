/** The tool-use eval's grader: plain logic, so it is tested like code (the eval itself is not run in CI). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolUseCase, type Expect } from "./case.ts";
import { argsMatch, bareToolName, casePasses, failedEarly, gradeSample, matches, type SampleRun } from "./grade.ts";

const expect = (fields: Partial<Record<keyof Expect, unknown>>): Expect =>
  ToolUseCase.parse({ id: "t", kind: "bad", pattern: "p", experience: "e", rule: "none", source: "s", prompt: "p", expect: fields }).expect;

const run = (calls: [string, Record<string, unknown>?][], finalText = ""): SampleRun => ({
  calls: calls.map(([tool, input]) => ({ tool, input: input ?? {} })),
  finalText
});

test("argument matching: substring, bounds, nesting, dotted paths, exact values", () => {
  assert.ok(matches("~Codex", "use codex please"));
  assert.ok(!matches("~codex", 42));
  assert.ok(matches("<=3", 3) && !matches("<=3", 4) && matches(">=1", 2));
  assert.ok(matches({ a: { b: "~x" } }, { a: { b: "xyz", c: 1 } }));
  assert.ok(!matches({ a: 1 }, null));
  assert.ok(argsMatch({ "target.agentId": "codex" }, { target: { agentId: "codex" } }));
  assert.ok(!argsMatch({ reply: "notify" }, { reply: "wait" }));
  assert.ok(argsMatch(undefined, {}));
});

test("Orquester tool names lose their server prefix; native names stay", () => {
  assert.equal(bareToolName("mcp__orquester__create_session"), "create_session");
  assert.equal(bareToolName("Bash"), "Bash");
});

test("calls / callsMustNot / notCalls", () => {
  const checks = expect({ calls: [{ tool: "create_session", args: { delegate: true } }], callsMustNot: [{ tool: "send_message", args: { reply: "wait" } }], notCalls: ["Agent"] });
  assert.deepEqual(gradeSample(checks, run([["create_session", { delegate: true }]])), []);
  assert.deepEqual(gradeSample(checks, run([["create_session", { delegate: false }], ["send_message", { reply: "wait" }], ["Agent"]])), [
    'calls missing create_session {"delegate":true}',
    'callsMustNot made send_message {"reply":"wait"}',
    "notCalls made Agent"
  ]);
});

test("maxCalls and minCalls count by tool", () => {
  const checks = expect({ maxCalls: { get_session: 1 }, minCalls: { html_preview: 1 } });
  assert.deepEqual(gradeSample(checks, run([["html_preview"], ["get_session"]])), []);
  assert.deepEqual(gradeSample(checks, run([["get_session"], ["get_session"]])), ["maxCalls get_session 2 > 1", "minCalls html_preview 0 < 1"]);
});

test("order compares each tool's first call", () => {
  const checks = expect({ order: ["html_preview", "html_render"] });
  assert.deepEqual(gradeSample(checks, run([["html_preview"], ["html_render"], ["html_preview"]])), []);
  assert.deepEqual(gradeSample(checks, run([["html_render"], ["html_preview"]])), ["order not html_preview → html_render"]);
  assert.deepEqual(gradeSample(checks, run([["html_render"]])), ["order missing html_preview"]);
});

test("endsTurnAfter: the tool is called and nothing follows it", () => {
  const checks = expect({ endsTurnAfter: "send_message" });
  assert.deepEqual(gradeSample(checks, run([["Read"], ["send_message"]])), []);
  assert.deepEqual(gradeSample(checks, run([["send_message"], ["get_session"]])), ["endsTurnAfter send_message followed by get_session"]);
  assert.deepEqual(gradeSample(checks, run([["Read"]])), ["endsTurnAfter missing send_message"]);
});

test("shellMustNot reads Bash commands; text checks read the final reply, case-insensitively", () => {
  const checks = expect({ shellMustNot: ["\\bhcloud\\b"], textMust: ["sess-\\d+"], textMustNot: ["paste .* here"] });
  assert.deepEqual(gradeSample(checks, run([["Bash", { command: "ls" }]], "Opened SESS-12.")), []);
  assert.deepEqual(gradeSample(checks, run([["Bash", { command: "hcloud server create" }]], "Paste the token here")), [
    'shellMustNot ran "hcloud server create"',
    "textMust missing /sess-\\d+/",
    "textMustNot matched /paste .* here/"
  ]);
});

test("a sample stops early only on a failure later calls cannot undo", () => {
  const checks = expect({ calls: [{ tool: "create_session" }], notCalls: ["Agent"], textMust: ["done"] });
  assert.equal(failedEarly(checks, run([["Read"]])), false);
  assert.equal(failedEarly(checks, run([["Agent"]])), true);
});

test("a case fails when half or more of its samples fail", () => {
  assert.equal(casePasses([{ pass: true }, { pass: true }, { pass: false }]), true);
  assert.equal(casePasses([{ pass: true }, { pass: false }]), false);
  assert.equal(casePasses([]), false);
});
