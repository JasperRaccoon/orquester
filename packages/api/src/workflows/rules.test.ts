import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuleOperator, WorkflowRule } from "@orquester/config";

import type { ExpressionContext } from "./expressions.ts";
import {
  evaluateRule,
  evaluateRules,
  evaluateSwitch,
} from "./rules.ts";

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

function check(left: string, op: RuleOperator, right?: string): boolean {
  return evaluateRule(rule(left, op, right), ctx).result;
}

describe("evaluateRule", () => {
  it("equals / notEquals compare loosely across representations", () => {
    assert.equal(check("{{ nodes.Fetch.output.count }}", "equals", "3"), true);
    assert.equal(check("{{ nodes.Fetch.output.count }}", "equals", "3.0"), true);
    assert.equal(check("{{ input.n }}", "equals", "10"), true);
    assert.equal(check("{{ nodes.Fetch.output.flag }}", "equals", "true"), true);
    assert.equal(check("{{ nodes.Fetch.output.flag }}", "equals", " TRUE "), true);
    assert.equal(check("{{ input.s }}", "equals", "abc"), true);
    assert.equal(check("{{ input.s }}", "equals", "ABC"), false);
    assert.equal(check("{{ input.s }}", "notEquals", "x"), true);
    assert.equal(check("{{ nodes.Fetch.output.tickets }}", "equals", '["A-1","A-2"]'), true);
    assert.equal(check("x-{{ input.s }}", "equals", "x-abc"), true, "a mixed template compares as text");
  });

  it("contains searches lists by element and text by substring", () => {
    assert.equal(check("{{ nodes.Fetch.output.tickets }}", "contains", "A-2"), true);
    assert.equal(check("{{ nodes.Fetch.output.tickets }}", "contains", "A-"), false, "elements, not substrings");
    assert.equal(check("{{ nodes.Fetch.output.text }}", "contains", "World"), true);
    assert.equal(check("{{ nodes.Fetch.output.text }}", "notContains", "Mars"), true);
    assert.equal(check("{{ nodes.Fetch.output.text }}", "startsWith", "Hello"), true);
    assert.equal(check("{{ nodes.Fetch.output.text }}", "endsWith", "World\n"), true);
  });

  it("numeric comparisons parse numbers and warn on non-numbers", () => {
    assert.equal(check("{{ nodes.Fetch.output.count }}", "gt", "2"), true);
    assert.equal(check("{{ input.n }}", "gte", "10"), true);
    assert.equal(check("{{ input.n }}", "lt", "9.5"), false);
    assert.equal(check("{{ input.n }}", "lte", "1e2"), true);
    const bad = evaluateRule(rule("{{ input.s }}", "gt", "1"), ctx);
    assert.equal(bad.result, false);
    assert.match(bad.warnings[0]!, /not a number/);
    for (const invalid of ["0x10", "", "Infinity"]) {
      const result = evaluateRule(rule(invalid, "gt", "-1"), ctx);
      assert.equal(result.result, false);
      assert.equal(result.warnings.length, 1);
    }
  });

  it("presence operators treat a missing value as an answer, without a warning", () => {
    const missing = evaluateRule(rule("{{ nodes.Fetch.output.nope }}", "exists"), ctx);
    assert.deepEqual(missing, { result: false, warnings: [] });
    assert.equal(check("{{ nodes.Fetch.output.count }}", "exists"), true);
    assert.equal(check("{{ input.nil }}", "exists"), true, "null is a value");
    assert.deepEqual(evaluateRule(rule("{{ nodes.Nope.output }}", "isEmpty"), ctx), { result: true, warnings: [] });
    assert.equal(check("{{ nodes.Fetch.output.none }}", "isEmpty"), true);
    assert.equal(check("{{ input.obj }}", "isEmpty"), true);
    assert.equal(check("{{ nodes.Agent.output.text }}", "isEmpty"), true, "whitespace only");
    assert.equal(check("{{ input.full }}", "isNotEmpty"), true);
    assert.equal(check("{{ nodes.Fetch.output.count }}", "isNotEmpty"), true);
    const warned = evaluateRule(rule("{{ nodes.Fetch.output.nope }}", "equals", ""), ctx);
    assert.equal(warned.result, true);
    assert.equal(warned.warnings.length, 1, "a comparison on a missing value warns");
  });

  it("isTrue / isFalse", () => {
    assert.equal(check("{{ nodes.Fetch.output.flag }}", "isTrue"), true);
    assert.equal(check("{{ input.t }}", "isTrue"), true);
    assert.equal(check("{{ input.f }}", "isFalse"), true);
    assert.equal(check("{{ input.s }}", "isTrue"), false);
    assert.equal(check("{{ input.s }}", "isFalse"), false);
  });

  it("matches with plain and /literal/flags patterns", () => {
    assert.equal(check("{{ input.s }}", "matches", "^a.c$"), true);
    assert.equal(check("{{ input.s }}", "matches", "^A"), false);
    assert.equal(check("{{ input.s }}", "matches", "/^A/i"), true);
    assert.equal(check("{{ input.s }}", "matches", "/b/g"), true);
    assert.equal(check("{{ input.s }}", "matches", "/b/g"), true, "g is dropped, so a second test is the same");
    const invalid = evaluateRule(rule("{{ input.s }}", "matches", "(unclosed"), ctx);
    assert.equal(invalid.result, false);
    assert.match(invalid.warnings[0]!, /refused/);
    assert.match(evaluateRule(rule("x", "matches", "/a/q"), ctx).warnings[0]!, /flags/);
  });

  it("matches refuses catastrophic patterns", () => {
    for (const pattern of ["(a+)+$", "(.*)*", "(\\w+\\s?)*$", "((ab)+)*", "(a|aa)*b", "(x+){2,}", "(a)\\1", "(?<x>a)\\k<x>"]) {
      const evaluated = evaluateRule(rule("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "matches", pattern), ctx);
      assert.equal(evaluated.result, false, pattern);
      assert.equal(evaluated.warnings.length, 1, pattern);
    }
    for (const pattern of ["^v\\d+\\.\\d+", "(foo|bar)+", "(?:ab)+c", "[(+)]+", "a{2,3}", "(ab)?c*", "\\(a+\\)+", "x(a+)y"]) {
      assert.deepEqual(evaluateRule(rule("anything", "matches", pattern), ctx).warnings, [], pattern);
    }
    assert.equal(evaluateRule(rule("x", "matches", "a".repeat(1001)), ctx).warnings.length, 1);
  });

  it("matches only searches the first 100 KB", () => {
    const big: ExpressionContext = { ...ctx, input: { text: "x".repeat(100 * 1024) + "NEEDLE" } };
    const evaluated = evaluateRule(rule("{{ input.text }}", "matches", "NEEDLE"), big);
    assert.equal(evaluated.result, false);
    assert.match(evaluated.warnings[0]!, /first 100 KB/);
  });
});

describe("evaluateRules", () => {
  const yes = rule("{{ input.s }}", "equals", "abc");
  const no = rule("{{ input.s }}", "equals", "zzz");
  it("combines with all / any", () => {
    assert.equal(evaluateRules("all", [yes, yes], ctx).result, true);
    assert.equal(evaluateRules("all", [yes, no], ctx).result, false);
    assert.equal(evaluateRules("any", [no, yes], ctx).result, true);
    assert.equal(evaluateRules("any", [no, no], ctx).result, false);
    assert.equal(evaluateRules("all", [], ctx).result, true);
    assert.equal(evaluateRules("any", [], ctx).result, false);
  });

  it("collects every rule's warnings", () => {
    const evaluated = evaluateRules("any", [yes, rule("{{ input.x }}", "equals", "1"), rule("{{ input.y }}", "equals", "1")], ctx);
    assert.equal(evaluated.warnings.length, 2);
  });
});

describe("evaluateSwitch", () => {
  const config = {
    cases: [
      { label: "big", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "5")] },
      { label: "some", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "0")] },
      { label: "also", combine: "all" as const, rules: [rule("{{ nodes.Fetch.output.count }}", "gt", "1")] }
    ],
    fallback: true
  };
  it("takes the first matching case", () => {
    assert.deepEqual(evaluateSwitch(config, ctx), { handle: "case:1", warnings: [] });
  });
  it("falls back to default, or to nothing", () => {
    const none = { ...config, cases: [config.cases[0]!] };
    assert.equal(evaluateSwitch(none, ctx).handle, "default");
    assert.equal(evaluateSwitch({ ...none, fallback: false }, ctx).handle, null);
  });
});
