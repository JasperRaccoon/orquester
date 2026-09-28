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

/**
 * A secret value inside a text that is about to be CLIPPED into a warning: replaced by its
 * placeholder first, so a clip can never leave a secret's prefix behind that the engine's redactor
 * (which matches whole values) would no longer recognise.
 */
function redactForClip(text: string, secrets: Readonly<Record<string, string>> | undefined): string {
  if (!secrets) return text;
  const entries = Object.keys(secrets)
    .sort()
    .map((name) => [name, secrets[name]] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string" && entry[1].length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) if (out.includes(value)) out = out.split(value).join(`«secret:${name}»`);
  return out;
}

function clipped(text: string, ctx: ExpressionContext, max = 60): string {
  return redactForClip(text, ctx.secrets).slice(0, max);
}

interface RuleOperands {
  left: unknown;
  right: string;
  warnings: string[];
}

function ruleOperands(rule: WorkflowRule, ctx: ExpressionContext): RuleOperands {
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
  return { left, right, warnings };
}

/** What a `matches` rule searches: the compiled pattern and the (capped) text; null when refused. */
export interface RuleMatchJob {
  source: string;
  flags: string;
  text: string;
}

function prepareMatch(operands: RuleOperands): { job: RuleMatchJob; regex: RegExp } | null {
  const compiled = compileRulePattern(operands.right);
  if ("error" in compiled) {
    operands.warnings.push(`Rule "matches": the pattern is refused — ${compiled.error}`);
    return null;
  }
  let text = ruleText(operands.left);
  if (text.length > RULE_MATCH_MAX_INPUT) {
    operands.warnings.push(`Rule "matches": only the first ${RULE_MATCH_MAX_INPUT / 1024} KB of the value were searched`);
    text = text.slice(0, RULE_MATCH_MAX_INPUT);
  }
  return { job: { source: compiled.regex.source, flags: compiled.regex.flags, text }, regex: compiled.regex };
}

/** Every operator but `matches` (decided by the caller, sync or async). */
function decideRule(rule: WorkflowRule, operands: RuleOperands, ctx: ExpressionContext): boolean {
  const { left, right, warnings } = operands;
  const numeric = (compare: (a: number, b: number) => boolean): boolean => {
    const a = ruleNumber(left);
    const b = ruleNumber(right);
    if (a === null || b === null) {
      warnings.push(`Rule "${rule.op}": "${a === null ? clipped(ruleText(left), ctx) : clipped(right, ctx)}" is not a number`);
      return false;
    }
    return compare(a, b);
  };

  switch (rule.op) {
    case "equals":
      return looseEquals(left, right);
    case "notEquals":
      return !looseEquals(left, right);
    case "contains":
      return Array.isArray(left) ? left.some((item) => looseEquals(item, right)) : ruleText(left).includes(right);
    case "notContains":
      return !(Array.isArray(left) ? left.some((item) => looseEquals(item, right)) : ruleText(left).includes(right));
    case "startsWith":
      return ruleText(left).startsWith(right);
    case "endsWith":
      return ruleText(left).endsWith(right);
    case "matches":
      // Decided by the caller (evaluateRule / evaluateRuleAsync).
      return false;
    case "gt":
      return numeric((a, b) => a > b);
    case "gte":
      return numeric((a, b) => a >= b);
    case "lt":
      return numeric((a, b) => a < b);
    case "lte":
      return numeric((a, b) => a <= b);
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "exists":
      return left !== undefined;
    case "isTrue":
      return left === true || (typeof left === "string" && left.trim().toLowerCase() === "true");
    case "isFalse":
      return left === false || (typeof left === "string" && left.trim().toLowerCase() === "false");
    default: {
      const unhandled: never = rule.op;
      warnings.push(`Unknown rule operator "${String(unhandled)}"`);
      return false;
    }
  }
}

/**
 * Evaluate one rule. Never throws. `matches` runs IN THIS THREAD behind the pattern guard — fine for
 * a preview; the daemon evaluates rules with {@link evaluateRuleAsync} and a matcher that runs the
 * regular expression in a worker with a hard timeout, because no guard catches every slow pattern.
 */
export function evaluateRule(rule: WorkflowRule, ctx: ExpressionContext): RuleEvaluation {
  const operands = ruleOperands(rule, ctx);
  if (rule.op === "matches") {
    const prepared = prepareMatch(operands);
    return { result: prepared !== null && prepared.regex.test(prepared.job.text), warnings: operands.warnings };
  }
  return { result: decideRule(rule, operands, ctx), warnings: operands.warnings };
}

/** Runs a `matches` search somewhere safe: its answer, or a warning (a timeout) that reads as false. */
export type RuleMatcher = (job: RuleMatchJob) => Promise<{ result: boolean; warning?: string }>;

/** {@link evaluateRule} with `matches` handed to `matcher`. Never rejects. */
export async function evaluateRuleAsync(rule: WorkflowRule, ctx: ExpressionContext, matcher: RuleMatcher): Promise<RuleEvaluation> {
  const operands = ruleOperands(rule, ctx);
  if (rule.op !== "matches") return { result: decideRule(rule, operands, ctx), warnings: operands.warnings };
  const prepared = prepareMatch(operands);
  if (prepared === null) return { result: false, warnings: operands.warnings };
  try {
    const answer = await matcher(prepared.job);
    if (answer.warning !== undefined) operands.warnings.push(answer.warning);
    return { result: answer.result, warnings: operands.warnings };
  } catch (error) {
    operands.warnings.push(`Rule "matches": the pattern could not be evaluated — ${error instanceof Error ? error.message : String(error)}`);
    return { result: false, warnings: operands.warnings };
  }
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

/** {@link evaluateRules} with `matches` handed to `matcher`. */
export async function evaluateRulesAsync(
  combine: "all" | "any",
  rules: readonly WorkflowRule[],
  ctx: ExpressionContext,
  matcher: RuleMatcher
): Promise<RuleEvaluation> {
  const warnings: string[] = [];
  let all = true;
  let any = false;
  for (const rule of rules) {
    const evaluated = await evaluateRuleAsync(rule, ctx, matcher);
    warnings.push(...evaluated.warnings);
    all &&= evaluated.result;
    any ||= evaluated.result;
  }
  return { result: combine === "all" ? all : any, warnings };
}

/** {@link evaluateSwitch} with `matches` handed to `matcher`. */
export async function evaluateSwitchAsync(
  config: SwitchConfigLike,
  ctx: ExpressionContext,
  matcher: RuleMatcher
): Promise<{ handle: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  for (let index = 0; index < config.cases.length; index += 1) {
    const current = config.cases[index]!;
    const evaluated = await evaluateRulesAsync(current.combine, current.rules, ctx, matcher);
    warnings.push(...evaluated.warnings);
    if (evaluated.result) return { handle: `case:${index}`, warnings };
  }
  return { handle: config.fallback ? "default" : null, warnings };
}
