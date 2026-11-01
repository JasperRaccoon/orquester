/**
 * The tool-use eval's case format: one fake chat, the user's next message, and what the agent must
 * (not) do with Orquester's tools. Modelled on T3 Code's `evals/mcp-tool-use` cases (MIT), cut to
 * what Orquester's cases need. Cases are NDJSON in `cases/`, one file per area.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * A call the checks look for. `args` matches partially: nested keys by dotted path, a string
 * starting with `~` is a case-insensitive substring, `<=N` / `>=N` bound a number, anything else
 * must be equal.
 */
const CallSpec = z.object({ tool: z.string().min(1), args: z.record(z.unknown()).optional() }).strict();
export type CallSpec = z.infer<typeof CallSpec>;

const PriorCall = z
  .object({
    tool: z.string().min(1),
    input: z.record(z.unknown()).default({}),
    /** What the call returned: text, or a value sent as JSON. */
    result: z.unknown(),
    isError: z.boolean().optional()
  })
  .strict();

/** A turn already in the chat before `prompt`: the user's words, or the agent's text and calls. */
const PriorTurn = z.union([
  z.object({ user: z.string().min(1) }).strict(),
  z.object({ assistant: z.string().default(""), calls: z.array(PriorCall).default([]) }).strict()
]);
export type PriorTurn = z.infer<typeof PriorTurn>;

/** An Orquester tool's canned result; `when` matches the call's arguments like {@link CallSpec}. */
const Mock = z
  .object({ when: z.record(z.unknown()).optional(), result: z.unknown(), isError: z.boolean().optional() })
  .strict();
export type Mock = z.infer<typeof Mock>;

const Setup = z
  .object({
    /** The optional toolsets this chat is advertised (the manifest's inputs). */
    toolsets: z
      .object({
        boxes: z.boolean().optional(),
        devices: z.boolean().optional(),
        /** Knowledge collections the chat can see; present = the plugin is on. */
        knowledge: z.array(z.string()).optional()
      })
      .strict()
      .default({}),
    workflowOwned: z.boolean().default(false),
    /** Files written into the chat's (throwaway) cwd. */
    files: z.record(z.string()).default({}),
    priorTurns: z.array(PriorTurn).default([]),
    /** Orquester tool → its result(s); the first matching `when` wins, else the tool's default. */
    mocks: z.record(z.union([Mock, z.array(Mock)])).default({}),
    /**
     * Regex (on a Bash command) → the output it prints. An unmatched command that only reads the
     * cwd runs there; any other is answered by a cheap model playing this machine (`shell-sim.ts`).
     */
    shell: z.record(z.string()).default({}),
    /** What the simulated shell must agree with: hosts, hardware, services, what is running. */
    machine: z.string().optional(),
    /** A native tool (Agent, WebFetch, …) → the text it is refused with, instead of the default. */
    native: z.record(z.string()).default({}),
    /** What a native subagent (`Agent`) reports back; it runs as a stand-in that only says this. */
    agentReport: z.string().optional()
  })
  .strict();

const Expect = z
  .object({
    calls: z.array(CallSpec).default([]),
    callsMustNot: z.array(CallSpec).default([]),
    notCalls: z.array(z.string()).default([]),
    /** These tools' first calls happen in this order. */
    order: z.array(z.string()).default([]),
    maxCalls: z.record(z.number().int().min(0)).default({}),
    minCalls: z.record(z.number().int().min(1)).default({}),
    /** This tool is called, and is the last tool call of the turn. */
    endsTurnAfter: z.string().optional(),
    /** Regexes no Bash command may match. */
    shellMustNot: z.array(z.string()).default([]),
    /** Regexes (case-insensitive) the final reply must / must not match. */
    textMust: z.array(z.string()).default([]),
    textMustNot: z.array(z.string()).default([])
  })
  .strict();
export type Expect = z.infer<typeof Expect>;

export const ToolUseCase = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** `bad` reproduces a real mistake, `guard` protects a real good behaviour, `control` is ordinary work. */
    kind: z.enum(["bad", "guard", "control"]),
    pattern: z.string().min(1),
    /** What actually happened, in a sentence or two. */
    experience: z.string().min(1),
    /** The current Orquester text at issue, quoted, or "none". */
    rule: z.string().min(1),
    /** Where it happened: a chat, a commit. */
    source: z.string().min(1),
    notes: z.string().optional(),
    setup: Setup.default({}),
    prompt: z.string().min(1),
    expect: Expect
  })
  .strict();
export type ToolUseCase = z.infer<typeof ToolUseCase>;

/** Every case under `dir` (`*.ndjson`), each validated; a bad line names its file and line. */
export async function loadCases(dir: string): Promise<ToolUseCase[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ndjson")).sort();
  const cases: ToolUseCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const lines = (await readFile(join(dir, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.trim().length === 0) return;
      const parsed = ToolUseCase.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${file}:${index + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      if (seen.has(parsed.data.id)) throw new Error(`${file}:${index + 1}: duplicate id ${parsed.data.id}`);
      seen.add(parsed.data.id);
      cases.push(parsed.data);
    });
  }
  return cases;
}
