import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuleOperator, WorkflowRule } from "@orquester/config";

import type { ExpressionContext } from "./expressions.ts";
import {
  evaluateRuleAsync,
  evaluateRulesAsync,
  evaluateSwitchAsync,
} from "./rules.ts";

const matcher = async (job: { source: string; flags: string; text: string }) => ({
  result: new RegExp(job.source, job.flags).test(job.text)
});

const ctx: ExpressionContext = {
  nodes: {
    Fetch: { status: "succeeded", output: { count: 3, tickets: ["A-1", "A-2"], none: [], flag: true, text: "Hello World\n" } },
    Agent: { status: "succeeded", output: { text: "  " } }
  },
  input: { n: "10", s: "abc", obj: {}, full: { a: 1 }, t: "TRUE", f: "false", nil: null },
  trigger: { kind: "manual" },
  run: {},
  project: {},
  secrets: {}
};

function rule(left: string, op: RuleOperator, right?: string): WorkflowRule {
  return right === undefined ? { left, op } : { left, op, right };
}

async function check(left: string, op: RuleOperator, right?: string): Promise<boolean> {
  return (await evaluateRuleAsync(rule(left, op, right), ctx, matcher)).result;
}

describe("evaluateRuleAsync", () => {
  it("equals / notEquals compare loosely across representations", async () => {
    assert.equal((await check("{{ nodes.Fetch.output.count }}", "equals", "3")), true);
    assert.equal((await check("{{ nodes.Fetch.output.count }}", "equals", "3.0")), true);
    assert.equal((await check("{{ input.n }}", "equals", "10")), true);
    assert.equal((await check("{{ nodes.Fetch.output.flag }}", "equals", "true")), true);
    assert.equal((await check("{{ nodes.Fetch.output.flag }}", "equals", " TRUE ")), true);
    assert.equal((await check("{{ input.s }}", "equals", "abc")), true);
    assert.equal((await check("{{ input.s }}", "equals", "ABC")), false);
    assert.equal((await check("{{ input.s }}", "notEquals", "x")), true);
    assert.equal((await check("{{ nodes.Fetch.output.tickets }}", "equals", '["A-1","A-2"]')), true);
    assert.equal((await check("x-{{ input.s }}", "equals", "x-abc")), true, "a mixed template compares as text");
  });

  it("contains searches lists by element and text by substring", async () => {
    assert.equal((await check("{{ nodes.Fetch.output.tickets }}", "contains", "A-2")), true);
    assert.equal((await check("{{ nodes.Fetch.output.tickets }}", "contains", "A-")), false, "elements, not substrings");
    assert.equal((await check("{{ nodes.Fetch.output.text }}", "contains", "World")), true);
    assert.equal((await check("{{ nodes.Fetch.output.text }}", "notContains", "Mars")), true);
    assert.equal((await check("{{ nodes.Fetch.output.text }}", "startsWith", "Hello")), true);
    assert.equal((await check("{{ nodes.Fetch.output.text }}", "endsWith", "World\n")), true);
  });

  it("numeric comparisons parse numbers and warn on non-numbers", async () => {
    assert.equal((await check("{{ nodes.Fetch.output.count }}", "gt", "2")), true);
    assert.equal((await check("{{ input.n }}", "gte", "10")), true);
    assert.equal((await check("{{ input.n }}", "lt", "9.5")), false);
    assert.equal((await check("{{ input.n }}", "lte", "1e2")), true);
    const bad = (await evaluateRuleAsync(rule("{{ input.s }}", "gt", "1"), ctx, matcher));
    assert.equal(bad.result, false);
    assert.equal(bad.warnings.length, 1);
    for (const invalid of ["0x10", "", "Infinity"]) {
      const result = (await evaluateRuleAsync(rule(invalid, "gt", "-1"), ctx, matcher));
      assert.equal(result.result, false);
      assert.equal(result.warnings.length, 1);
    }
  });

  it("presence operators treat a missing value as an answer, without a warning", async () => {
    const missing = (await evaluateRuleAsync(rule("{{ nodes.Fetch.output.nope }}", "exists"), ctx, matcher));
    assert.deepEqual(missing, { result: false, warnings: [] });
    assert.equal((await check("{{ nodes.Fetch.output.count }}", "exists")), true);
    assert.equal((await check("{{ input.nil }}", "exists")), true, "null is a value");
    assert.deepEqual((await evaluateRuleAsync(rule("{{ nodes.Nope.output }}", "isEmpty"), ctx, matcher)), { result: true, warnings: [] });
    assert.equal((await check("{{ nodes.Fetch.output.none }}", "isEmpty")), true);
    assert.equal((await check("{{ input.obj }}", "isEmpty")), true);
    assert.equal((await check("{{ nodes.Agent.output.text }}", "isEmpty")), true, "whitespace only");
    assert.equal((await check("{{ input.full }}", "isNotEmpty")), true);
    assert.equal((await check("{{ nodes.Fetch.output.count }}", "isNotEmpty")), true);
    const warned = (await evaluateRuleAsync(rule("{{ nodes.Fetch.output.nope }}", "equals", ""), ctx, matcher));
    assert.equal(warned.result, true);
    assert.equal(warned.warnings.length, 1, "a comparison on a missing value warns");
  });

  it("isTrue / isFalse", async () => {
    assert.equal((await check("{{ nodes.Fetch.output.flag }}", "isTrue")), true);
    assert.equal((await check("{{ input.t }}", "isTrue")), true);
    assert.equal((await check("{{ input.f }}", "isFalse")), true);
    assert.equal((await check("{{ input.s }}", "isTrue")), false);
    assert.equal((await check("{{ input.s }}", "isFalse")), false);
  });

  it("matches with plain and /literal/flags patterns", async () => {
    assert.equal((await check("{{ input.s }}", "matches", "^a.c$")), true);
    assert.equal((await check("{{ input.s }}", "matches", "^A")), false);
    assert.equal((await check("{{ input.s }}", "matches", "/^A/i")), true);
    assert.equal((await check("{{ input.s }}", "matches", "/b/g")), true);
    assert.equal((await check("{{ input.s }}", "matches", "/b/g")), true, "g is dropped, so a second test is the same");
    const invalid = (await evaluateRuleAsync(rule("{{ input.s }}", "matches", "(unclosed"), ctx, matcher));
    assert.equal(invalid.result, false);
    assert.equal(invalid.warnings.length, 1);
    assert.equal((await evaluateRuleAsync(rule("x", "matches", "/a/q"), ctx, matcher)).warnings.length, 1);
  });

  it("matches refuses catastrophic patterns", async () => {
    for (const pattern of ["(a+)+$", "(.*)*", "(\\w+\\s?)*$", "((ab)+)*", "(a|aa)*b", "(x+){2,}", "(a)\\1", "(?<x>a)\\k<x>"]) {
      const evaluated = (await evaluateRuleAsync(rule("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "matches", pattern), ctx, matcher));
      assert.equal(evaluated.result, false, pattern);
      assert.equal(evaluated.warnings.length, 1, pattern);
    }
    for (const pattern of ["^v\\d+\\.\\d+", "(foo|bar)+", "(?:ab)+c", "[(+)]+", "a{2,3}", "(ab)?c*", "\\(a+\\)+", "x(a+)y"]) {
      assert.deepEqual((await evaluateRuleAsync(rule("anything", "matches", pattern), ctx, matcher)).warnings, [], pattern);
    }
    assert.equal((await evaluateRuleAsync(rule("x", "matches", "a".repeat(1001)), ctx, matcher)).warnings.length, 1);
  });

  it("matches only searches the first 100 KB", async () => {
    const big: ExpressionContext = { ...ctx, input: { text: "x".repeat(100 * 1024) + "NEEDLE" } };
    const evaluated = (await evaluateRuleAsync(rule("{{ input.text }}", "matches", "NEEDLE"), big, matcher));
    assert.equal(evaluated.result, false);
    assert.equal(evaluated.warnings.length, 1);
  });
});

describe("evaluateRulesAsync", () => {
  const yes = rule("{{ input.s }}", "equals", "abc");
  const no = rule("{{ input.s }}", "equals", "zzz");
  it("combines with all / any", async () => {
    assert.equal((await evaluateRulesAsync("all", [yes, yes], ctx, matcher)).result, true);
    assert.equal((await evaluateRulesAsync("all", [yes, no], ctx, matcher)).result, false);
    assert.equal((await evaluateRulesAsync("any", [no, yes], ctx, matcher)).result, true);
    assert.equal((await evaluateRulesAsync("any", [no, no], ctx, matcher)).result, false);
    assert.equal((await evaluateRulesAsync("all", [], ctx, matcher)).result, true);
    assert.equal((await evaluateRulesAsync("any", [], ctx, matcher)).result, false);
  });

  it("collects every rule's warnings", async () => {
    const evaluated = (await evaluateRulesAsync("any", [yes, rule("{{ input.x }}", "equals", "1"), rule("{{ input.y }}", "equals", "1")], ctx, matcher));
    assert.equal(evaluated.warnings.length, 2);
  });
});

describe("evaluateSwitchAsync", () => {
  const config = {
    cases: [
      { label: "big", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "5")] },
      { label: "some", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "0")] },
      { label: "also", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "1")] }
    ],
    fallback: true
  };
  it("takes the first matching case", async () => {
    assert.deepEqual((await evaluateSwitchAsync(config, ctx, matcher)), { handle: "case:1", warnings: [] });
  });
  it("falls back to default, or to nothing", async () => {
    const none = { ...config, cases: [config.cases[0]!] };
    assert.equal((await evaluateSwitchAsync(none, ctx, matcher)).handle, "default");
    assert.equal((await evaluateSwitchAsync({ ...none, fallback: false }, ctx, matcher)).handle, null);
  });
});
