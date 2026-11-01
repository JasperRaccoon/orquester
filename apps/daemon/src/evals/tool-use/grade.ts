/**
 * The tool-use eval's grader: plain checks over what one sample did — no model judges. Ported in
 * shape from T3 Code's `gradeSample` (MIT, `evals/mcp-tool-use/run.ts`).
 */

import type { CallSpec, Expect } from "./case.ts";

/** One tool call the agent made, by its bare name (`mcp__orquester__x` → `x`). */
export interface RecordedCall {
  tool: string;
  input: Record<string, unknown>;
  /** What the call returned, clipped (for reading a run; no check uses it). */
  result?: string;
}

export interface SampleRun {
  calls: RecordedCall[];
  /** The text of the turn's last assistant message (its final reply). */
  finalText: string;
}

const ORQUESTER_PREFIX = /^mcp__orquester__/;

/** A provider's tool name as the cases spell it. */
export const bareToolName = (name: string): string => name.replace(ORQUESTER_PREFIX, "");

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;

/** Whether `actual` satisfies `expected` (see {@link CallSpec}). */
export function matches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    if (expected.startsWith("~")) return typeof actual === "string" && actual.toLowerCase().includes(expected.slice(1).toLowerCase());
    const bound = BOUND.exec(expected);
    if (bound !== null) {
      if (typeof actual !== "number") return false;
      const limit = Number(bound[2]);
      return bound[1] === "<=" ? actual <= limit : actual >= limit;
    }
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => matches(value, (actual as Record<string, unknown>)[key]));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => matches(value, actual[index]));
  }
  return Object.is(expected, actual);
}

/** `args` with dotted keys read as paths into `input`. */
export function argsMatch(args: Record<string, unknown> | undefined, input: Record<string, unknown>): boolean {
  if (args === undefined) return true;
  return Object.entries(args).every(([path, value]) => matches(value, readPath(input, path)));
}

function readPath(input: unknown, path: string): unknown {
  let value = input;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const callMatches = (spec: CallSpec, call: RecordedCall): boolean => spec.tool === call.tool && argsMatch(spec.args, call.input);

const describe = (spec: CallSpec): string => (spec.args === undefined ? spec.tool : `${spec.tool} ${JSON.stringify(spec.args)}`);

const shellCommands = (run: SampleRun): string[] =>
  run.calls.filter((call) => call.tool === "Bash" && typeof call.input.command === "string").map((call) => call.input.command as string);

/**
 * Every failed check, each line starting with the check's name; [] = pass. A failure of a check in
 * {@link SETTLED} can never be undone by later calls, so a run may stop at it ({@link failedEarly}).
 */
export function gradeSample(expect: Expect, run: SampleRun): string[] {
  const failures: string[] = [];
  const count = (tool: string) => run.calls.filter((call) => call.tool === tool).length;

  for (const spec of expect.calls) {
    if (!run.calls.some((call) => callMatches(spec, call))) failures.push(`calls missing ${describe(spec)}`);
  }
  for (const spec of expect.callsMustNot) {
    if (run.calls.some((call) => callMatches(spec, call))) failures.push(`callsMustNot made ${describe(spec)}`);
  }
  for (const tool of expect.notCalls) {
    if (count(tool) > 0) failures.push(`notCalls made ${tool}`);
  }
  for (const [tool, max] of Object.entries(expect.maxCalls)) {
    if (count(tool) > max) failures.push(`maxCalls ${tool} ${count(tool)} > ${max}`);
  }
  for (const [tool, min] of Object.entries(expect.minCalls)) {
    if (count(tool) < min) failures.push(`minCalls ${tool} ${count(tool)} < ${min}`);
  }
  if (expect.order.length > 0) {
    const firsts = expect.order.map((tool) => run.calls.findIndex((call) => call.tool === tool));
    const missing = expect.order.filter((_, index) => firsts[index] === -1);
    if (missing.length > 0) failures.push(`order missing ${missing.join(", ")}`);
    else if (firsts.some((position, index) => index > 0 && position < firsts[index - 1]!)) failures.push(`order not ${expect.order.join(" → ")}`);
  }
  if (expect.endsTurnAfter !== undefined) {
    const last = run.calls.at(-1);
    if (count(expect.endsTurnAfter) === 0) failures.push(`endsTurnAfter missing ${expect.endsTurnAfter}`);
    else if (last?.tool !== expect.endsTurnAfter) failures.push(`endsTurnAfter ${expect.endsTurnAfter} followed by ${last?.tool ?? "nothing"}`);
  }
  for (const pattern of expect.shellMustNot) {
    const regex = new RegExp(pattern, "i");
    const hit = shellCommands(run).find((command) => regex.test(command));
    if (hit !== undefined) failures.push(`shellMustNot ran ${JSON.stringify(hit.slice(0, 120))}`);
  }
  for (const pattern of expect.textMust) {
    if (!new RegExp(pattern, "i").test(run.finalText)) failures.push(`textMust missing /${pattern}/`);
  }
  for (const pattern of expect.textMustNot) {
    if (new RegExp(pattern, "i").test(run.finalText)) failures.push(`textMustNot matched /${pattern}/`);
  }
  return failures;
}

/** Checks whose failure later calls cannot undo (`textMustNot` waits for the final reply). */
const SETTLED = /^(notCalls|callsMustNot|shellMustNot|maxCalls) /;

/** The run so far already fails a check no later call can fix: stop it. */
export function failedEarly(expect: Expect, run: SampleRun): boolean {
  return gradeSample(expect, run).some((failure) => SETTLED.test(failure));
}

/** A case fails when half or more of its graded samples fail (T3's rule). */
export function casePasses(samples: readonly { pass: boolean }[]): boolean {
  const failed = samples.filter((sample) => !sample.pass).length;
  return samples.length > 0 && failed * 2 < samples.length;
}
