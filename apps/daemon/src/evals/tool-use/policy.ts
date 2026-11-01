/**
 * What a sample's built-in tools may do. The agent runs on this machine, so nothing it asks for
 * runs for real outside its throwaway cwd: a shell command prints the case's canned output, or —
 * when it only reads inside the cwd ({@link readsOnlyInCwd}) — runs there; any other prints what a
 * model playing the machine says it would (`shell-sim.ts`). Native subagents run as stand-ins that
 * only return the case's report. File tools stay inside the cwd, and the rest (web, questions to the user) are refused
 * with the case's text or a plain refusal. Orquester's own tools never come here: the stub answers.
 */

import { isAbsolute, relative, resolve } from "node:path";

import type { ToolUseCase } from "./case.ts";

export type NativeDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; reason: string }
  /** A shell command only a simulated machine can answer. */
  | { decision: "simulate"; command: string };

/** Tools that act only on files: allowed inside the cwd. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"]);
/** Tools with no effect outside the chat itself. */
const INERT_TOOLS = new Set(["ToolSearch", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "Skill"]);

export const DEFAULT_REFUSAL = "Not available in this environment.";

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Read-only commands that may run for real in the sample's cwd (a git repo of the case's files). */
const READ_ONLY = /^(ls|cat|head|tail|wc|pwd|tree|find|grep|rg|git (status|log|diff|branch|rev-parse|show|ls-files))(\s|$)/;
/** Harmless redirections stripped before the check. */
const QUIET = /\s*(2>\/dev\/null|2>&1|>\/dev\/null)/g;

/**
 * Whether `command` only reads inside the cwd: every `&&`/`||`/`;`/`|` segment is a read-only
 * command, with no substitution, redirection, absolute or parent path, home, or writing flag.
 */
export function readsOnlyInCwd(command: string): boolean {
  const bare = command.replace(QUIET, "");
  if (/[`$<>\\]|\.\.|(^|\s)[~/]/.test(bare)) return false;
  if (/\s(-exec|-execdir|-delete|-ok|-fprint\w*|--output)\b/.test(bare)) return false;
  const segments = bare.split(/&&|\|\||;|\|/).map((segment) => segment.trim());
  return segments.length > 0 && segments.every((segment) => READ_ONLY.test(segment));
}

/**
 * A single Bash command → the canned output of the first `setup.shell` regex it matches, else
 * undefined. A chained command (`;`, `&&`, `|`, a newline) is never canned — one regex would
 * answer for every part — so the shell model answers it, told the canned outputs (as T3 does).
 */
export function shellOutput(testCase: ToolUseCase, command: string): string | undefined {
  if (/&&|\|\||[;|\n]/.test(command.trim())) return undefined;
  for (const [pattern, output] of Object.entries(testCase.setup.shell)) {
    if (new RegExp(pattern, "i").test(command)) return output;
  }
  return undefined;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

function outsideCwd(input: Record<string, unknown>, cwd: string): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const rel = relative(cwd, resolve(cwd, value));
    if (rel.startsWith("..") || isAbsolute(rel)) return value;
  }
  return undefined;
}

/** A Bash call printing `output` instead of running. */
export const printing = (input: Record<string, unknown>, output: string): Record<string, unknown> => ({
  ...input,
  command: `printf '%s' ${quote(output)}`,
  run_in_background: false
});

export const DEFAULT_AGENT_REPORT = "Done. Nothing else to report.";

/**
 * A native subagent runs, but as a stand-in: the cheapest model, told to reply with the case's
 * report and nothing else. Its call — what the grader reads — is the agent's own, unchanged.
 */
export function standInAgent(testCase: ToolUseCase, input: Record<string, unknown>): Record<string, unknown> {
  const report = testCase.setup.agentReport ?? DEFAULT_AGENT_REPORT;
  return {
    ...input,
    subagent_type: "general-purpose",
    model: "haiku",
    prompt: `Use no tools. Reply with exactly the text between the markers, without the markers, and nothing else.\n<<<\n${report}\n>>>`
  };
}

/**
 * The decision for one built-in tool call. A Bash command with neither canned output nor a
 * read-only form is left for {@link NativeDecision} `simulate`: the caller asks the shell model.
 */
export function nativePolicy(testCase: ToolUseCase, tool: string, input: Record<string, unknown>, cwd: string): NativeDecision {
  if (tool.startsWith("mcp__orquester__")) return { decision: "allow" };
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const canned = shellOutput(testCase, command);
    if (canned !== undefined) return { decision: "allow", updatedInput: printing(input, canned) };
    if (readsOnlyInCwd(command)) return { decision: "allow", updatedInput: { ...input, run_in_background: false } };
    return { decision: "simulate", command };
  }
  if (tool === "Agent" && testCase.setup.native.Agent === undefined) return { decision: "allow", updatedInput: standInAgent(testCase, input) };
  if (FILE_TOOLS.has(tool)) {
    const outside = outsideCwd(input, cwd);
    return outside === undefined ? { decision: "allow" } : { decision: "deny", reason: `${outside} is outside this project.` };
  }
  if (INERT_TOOLS.has(tool)) return { decision: "allow" };
  return { decision: "deny", reason: testCase.setup.native[tool] ?? DEFAULT_REFUSAL };
}
