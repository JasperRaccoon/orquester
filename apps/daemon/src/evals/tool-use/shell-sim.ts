/**
 * The machine a sample's shell commands run on, played by a cheap model: what a command that
 * neither has canned output nor only reads the cwd would print. Ported from T3 Code's shell
 * simulator (MIT, `evals/mcp-tool-use/run.ts` SHELL_PROMPT), run through the SDK on the same
 * account as the sample — one turn, no tools, none of the account's settings.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ToolUseCase } from "./case.ts";

export const SHELL_MODEL = "claude-haiku-5-5";

const SHELL_PROMPT = `You play the computer a coding agent works on. You get a description of the machine, the agent's shell commands so far with their outputs, and one new command. Reply with JSON only: {"facts": "...", "output": "..."}. In "facts", note briefly what the output must agree with. In "output", put only the command's output, exactly as a real terminal prints it: no notes, headings, code fences, or corrections. The agent sees "output" unchanged.

If the command fails, start with "Exit code N", then the error. If it prints nothing, reply "(Bash completed with no output)". Stay consistent with the machine and with earlier outputs. Where the description is silent, invent plausible small details that fit it (file contents, hashes, sizes, hostnames) rather than printing nothing. Commands succeed unless the description says otherwise, including ssh to hosts it names, installs, builds and tests.`;

export interface ShellEntry {
  command: string;
  output: string;
}

/** File contents the simulator is shown in full, up to this many bytes in all; past it, names only. */
const FILES_SHOWN_MAX_BYTES = 24_000;

export interface ShellSimInput {
  testCase: ToolUseCase;
  cwd: string;
  files: readonly string[];
  history: readonly ShellEntry[];
  command: string;
  env: Record<string, string>;
  executable: string;
  signal: AbortSignal;
}

/** The simulator's prompt: the machine, this sample's earlier commands, then the new one. */
export function shellPrompt(input: Omit<ShellSimInput, "env" | "executable" | "signal">): string {
  const machine = [
    `Working directory: ${input.cwd} on Linux, a git checkout of acme/app on branch main with one commit. Tracked files: ${input.files.length > 0 ? input.files.join(", ") : "none"}.`,
    ...fileContents(input.testCase),
    ...(input.testCase.setup.machine !== undefined ? [`Machine: ${input.testCase.setup.machine}`] : []),
    ...(Object.keys(input.testCase.setup.shell).length > 0
      ? [`Commands matching these regexes print exactly this output: ${JSON.stringify(input.testCase.setup.shell)}`]
      : []),
    `The agent's task: ${input.testCase.prompt}`
  ];
  const history = input.history.map((entry) => `<command>${entry.command}</command>\n<output>\n${entry.output}\n</output>`);
  return [...machine, ...history, `New command:\n<command>${input.command}</command>`].join("\n\n");
}

/** The case's files verbatim, so a command reading them (a loop, an absolute path) prints what is really there. */
function fileContents(testCase: ToolUseCase): string[] {
  const entries = Object.entries(testCase.setup.files);
  const total = entries.reduce((sum, [path, content]) => sum + Buffer.byteLength(path) + Buffer.byteLength(content), 0);
  if (entries.length === 0 || total > FILES_SHOWN_MAX_BYTES) return [];
  return [`Their exact contents (a command reading them prints exactly this):\n${entries.map(([path, content]) => `<file path="${path}">\n${content}</file>`).join("\n")}`];
}

/** The output in the model's JSON reply, or its raw text when that is not JSON. */
export function parseShellReply(reply: string): string {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json) as { output?: unknown };
      if (typeof parsed.output === "string") return parsed.output.trim();
    } catch {
      // Not JSON after all: fall through to the raw text.
    }
  }
  return reply.trim();
}

export async function simulateShell(input: ShellSimInput): Promise<string> {
  const abort = new AbortController();
  input.signal.addEventListener("abort", () => abort.abort(), { once: true });
  let reply = "";
  const stream = query({
    prompt: shellPrompt(input),
    options: {
      model: SHELL_MODEL,
      systemPrompt: SHELL_PROMPT,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 1,
      persistSession: false,
      cwd: input.cwd,
      env: input.env,
      pathToClaudeCodeExecutable: input.executable,
      abortController: abort
    }
  });
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    if (message.type === "assistant") {
      reply += (message.message.content as { type: string; text?: string }[]).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    }
  }
  return parseShellReply(reply) || "(Bash completed with no output)";
}
