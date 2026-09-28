// Automated workflows — IF / Switch rule evaluation (spec §4).
//
// A rule's `left` is a template rendered to its raw VALUE (`{{ nodes.Fetch.output.count }}` stays a
// number); its `right` is a template rendered to text. Comparisons are deliberately forgiving about
// representation — `1` equals "1.0", `true` equals "true" — and never throw: a comparison that
// cannot be made is `false` plus a warning on the block.
//
// `matches` compiles the right side as a regular expression behind a guard, because the pattern is
// user text and the engine must not hang on it: patterns with nested quantifiers (`(a+)+`,
// `(.*)*`, `(\w+\s?)*`) or backreferences are refused, a pattern is at most 1 000 characters, and
// only the first 100 KB of the left side is searched.

import type { WorkflowRule } from "@orquester/config";
import {
  evaluateExpression,
  renderTemplate,
  singleExpression,
  stringifyExpressionValue,
  type ExpressionContext
} from "./expressions.ts";

export const RULE_MATCH_MAX_INPUT = 100 * 1024;
export const RULE_MATCH_MAX_PATTERN = 1000;

export interface RuleEvaluation {
  result: boolean;
  warnings: string[];
}

/** Operators whose point is to test for absence: a missing left side is an answer, not a warning. */
const PRESENCE_OPERATORS: ReadonlySet<string> = new Set(["exists", "isEmpty", "isNotEmpty"]);

function ruleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return stringifyExpressionValue(value, false) ?? "";
}

/** A finite number from a number or a numeric text; null otherwise. */
export function ruleNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function looseEquals(left: unknown, right: string): boolean {
  if (ruleText(left) === right) return true;
  const a = ruleNumber(left);
  const b = ruleNumber(right);
  if (a !== null && b !== null) return a === b;
  if (typeof left === "boolean") return right.trim().toLowerCase() === String(left);
  return false;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// The regex guard
// ---------------------------------------------------------------------------

const QUANTIFIER_BRACE = /^\{\d+(,\d*)?\}/;

function isQuantifierAt(pattern: string, index: number): boolean {
  const ch = pattern[index];
  return ch === "*" || ch === "+" || (ch === "{" && QUANTIFIER_BRACE.test(pattern.slice(index)));
}

/** A repeated alternation is safe only when its alternatives are plain words that start differently. */
function safeRepeatedAlternation(body: string): boolean {
  const content = body.replace(/^\?(:|<[A-Za-z_][A-Za-z0-9_]*>)/, "");
  if (/[()[\]\\.*+?{}^$]/.test(content)) return false;
  const alternatives = content.split("|");
  if (alternatives.some((alternative) => alternative.length === 0)) return false;
  const firsts = alternatives.map((alternative) => alternative[0]!.toLowerCase());
  return new Set(firsts).size === firsts.length;
}

/**
 * Why a pattern is refused, or null when it may be compiled. A heuristic against catastrophic
 * backtracking: a repeated group that itself contains a repeat (`(a+)+`, `(.*)*`), a repeated
 * alternation whose branches may overlap (`(a|aa)*`), and backreferences.
 */
export function unsafeRegexReason(pattern: string): string | null {
  if (pattern.length > RULE_MATCH_MAX_PATTERN) return `the pattern is longer than ${RULE_MATCH_MAX_PATTERN} characters`;
  const groups: { start: number; quantified: boolean; alternation: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!inClass && next !== undefined && /[1-9]/.test(next)) return "backreferences are not allowed";
      if (!inClass && next === "k" && pattern[i + 2] === "<") return "backreferences are not allowed";
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groups.push({ start: i, quantified: false, alternation: false });
      continue;
    }
    if (ch === "|") {
      const top = groups[groups.length - 1];
      if (top) top.alternation = true;
      continue;
    }
    if (isQuantifierAt(pattern, i)) {
      for (const group of groups) group.quantified = true;
      continue;
    }
    if (ch === ")") {
      const group = groups.pop();
      if (group === undefined) continue;
      if (isQuantifierAt(pattern, i + 1)) {
        if (group.quantified) return "nested quantifiers (like (a+)+ or (.*)*) can take forever to match";
        if (group.alternation && !safeRepeatedAlternation(pattern.slice(group.start + 1, i))) {
          return "a repeated alternation (like (a|aa)*) can take forever to match";
        }
      }
      if (group.quantified) for (const outer of groups) outer.quantified = true;
    }
  }
  return null;
}

/** `/pattern/flags` or a bare pattern → a RegExp, or the reason it is refused. */
export function compileRulePattern(source: string): { regex: RegExp } | { error: string } {
  let pattern = source;
  let flags = "";
  const literal = /^\/([\s\S]*)\/([A-Za-z]*)$/.exec(source);
  if (literal) {
    pattern = literal[1]!;
    if (!/^[gimsuy]*$/.test(literal[2]!)) return { error: `unknown regular-expression flags "${literal[2]!}"` };
    // Stateful flags make `test` depend on the previous call — dropped.
    flags = Array.from(new Set(literal[2]!.replace(/[gy]/g, ""))).join("");
  }
  const unsafe = unsafeRegexReason(pattern);
  if (unsafe !== null) return { error: unsafe };
  try {
    return { regex: new RegExp(pattern, flags) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid regular expression" };
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Evaluate one rule. Never throws. */
export function evaluateRule(rule: WorkflowRule, ctx: ExpressionContext): RuleEvaluation {
  const warnings: string[] = [];
  let left: unknown;
  const single = singleExpression(rule.left);
  if (single !== null) {
    const evaluated = evaluateExpression(single, ctx);
    left = evaluated.value;
    if (!PRESENCE_OPERATORS.has(rule.op)) warnings.push(...evaluated.warnings);
  } else {
    const rendered = renderTemplate(rule.left, ctx);
    left = rendered.text;
    warnings.push(...rendered.warnings);
  }
  let right = "";
  if (rule.right !== undefined) {
    const rendered = renderTemplate(rule.right, ctx);
    right = rendered.text;
    warnings.push(...rendered.warnings);
  }

  const numeric = (compare: (a: number, b: number) => boolean): boolean => {
    const a = ruleNumber(left);
    const b = ruleNumber(right);
    if (a === null || b === null) {
      warnings.push(
        `Rule "${rule.op}": ${a === null ? `"${ruleText(left).slice(0, 60)}"` : `"${right.slice(0, 60)}"`} is not a number`
      );
      return false;
    }
    return compare(a, b);
  };

  let result: boolean;
  switch (rule.op) {
    case "equals":
      result = looseEquals(left, right);
      break;
    case "notEquals":
      result = !looseEquals(left, right);
      break;
    case "contains":
      result = Array.isArray(left) ? left.some((item) => looseEquals(item, right)) : ruleText(left).includes(right);
      break;
    case "notContains":
      result = !(Array.isArray(left) ? left.some((item) => looseEquals(item, right)) : ruleText(left).includes(right));
      break;
    case "startsWith":
      result = ruleText(left).startsWith(right);
      break;
    case "endsWith":
      result = ruleText(left).endsWith(right);
      break;
    case "matches": {
      const compiled = compileRulePattern(right);
      if ("error" in compiled) {
        warnings.push(`Rule "matches": the pattern is refused — ${compiled.error}`);
        result = false;
        break;
      }
      let text = ruleText(left);
      if (text.length > RULE_MATCH_MAX_INPUT) {
        warnings.push(`Rule "matches": only the first ${RULE_MATCH_MAX_INPUT / 1024} KB of the value were searched`);
        text = text.slice(0, RULE_MATCH_MAX_INPUT);
      }
      result = compiled.regex.test(text);
      break;
    }
    case "gt":
      result = numeric((a, b) => a > b);
      break;
    case "gte":
      result = numeric((a, b) => a >= b);
      break;
    case "lt":
      result = numeric((a, b) => a < b);
      break;
    case "lte":
      result = numeric((a, b) => a <= b);
      break;
    case "isEmpty":
      result = isEmptyValue(left);
      break;
    case "isNotEmpty":
      result = !isEmptyValue(left);
      break;
    case "exists":
      result = left !== undefined;
      break;
    case "isTrue":
      result = left === true || (typeof left === "string" && left.trim().toLowerCase() === "true");
      break;
    case "isFalse":
      result = left === false || (typeof left === "string" && left.trim().toLowerCase() === "false");
      break;
    default: {
      const unhandled: never = rule.op;
      warnings.push(`Unknown rule operator "${String(unhandled)}"`);
      result = false;
    }
  }
  return { result, warnings };
}

/** `all`: every rule holds (an empty list holds); `any`: at least one does. Every rule is evaluated. */
export function evaluateRules(
  combine: "all" | "any",
  rules: readonly WorkflowRule[],
  ctx: ExpressionContext
): RuleEvaluation {
  const warnings: string[] = [];
  let all = true;
  let any = false;
  for (const rule of rules) {
    const evaluated = evaluateRule(rule, ctx);
    warnings.push(...evaluated.warnings);
    all &&= evaluated.result;
    any ||= evaluated.result;
  }
  return { result: combine === "all" ? all : any, warnings };
}

export interface SwitchConfigLike {
  cases: readonly { label?: string; combine: "all" | "any"; rules: readonly WorkflowRule[] }[];
  fallback: boolean;
}

/**
 * The first case whose rules hold wins: `case:<index>`. No match: `default` when the switch has a
 * fallback output, else `null` (every outgoing edge is dead).
 */
export function evaluateSwitch(
  config: SwitchConfigLike,
  ctx: ExpressionContext
): { handle: string | null; warnings: string[] } {
  const warnings: string[] = [];
  for (let index = 0; index < config.cases.length; index += 1) {
    const current = config.cases[index]!;
    const evaluated = evaluateRules(current.combine, current.rules, ctx);
    warnings.push(...evaluated.warnings);
    if (evaluated.result) return { handle: `case:${index}`, warnings };
  }
  return { handle: config.fallback ? "default" : null, warnings };
}
