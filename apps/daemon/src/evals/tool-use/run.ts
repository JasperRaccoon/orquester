/**
 * The tool-use eval: replays each case as a real Claude Code chat — the SDK launch a chat gets
 * (`buildClaudeQueryOptions`), the thread's real `orquester` tool list and instruction block — on a
 * managed account the user names, and grades what the agent did. See README.md.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveBaseDir } from "@orquester/config";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import { buildClaudeQueryOptions } from "../../agent-host/adapters/claude/launch.ts";
import { resolveAccount, type EvalAccount } from "./accounts.ts";
import { loadCases, ToolUseCase } from "./case.ts";
import { bareToolName, casePasses, failedEarly, gradeSample, type RecordedCall } from "./grade.ts";
import { buildTranscript, claudeProjectSlug, claudeTranscriptPath } from "./history.ts";
import { nativePolicy, printing } from "./policy.ts";
import { simulateShell, type ShellEntry } from "./shell-sim.ts";
import { advertisedFor, buildStubServer } from "./stub.ts";

const RESULT_CLIP = 2_000;

/** A tool_result's content as text. */
const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type ?? "?"}]`)).join("\n")
      : JSON.stringify(content);

const CASES_DIR = join(dirname(new URL(import.meta.url).pathname), "cases");
const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];

interface Flags {
  account?: string;
  appdir: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  cases: ToolUseCase[];
  samples: number;
  concurrency: number;
  maxTurns: number;
  out?: string;
  baseline?: string;
  dryRun: boolean;
  context: boolean;
}

export interface SampleResult {
  case: string;
  kind: string;
  sample: number;
  model: string;
  account: string;
  pass: boolean;
  failures: string[];
  stoppedEarly: boolean;
  calls: RecordedCall[];
  finalText: string;
  costUsd: number;
  durationMs: number;
  error?: string;
}

async function readFlags(argv: string[]): Promise<Flags> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: "string" },
      appdir: { type: "string" },
      model: { type: "string", default: "claude-sonnet-5-5" },
      effort: { type: "string" },
      case: { type: "string" },
      cases: { type: "string" },
      samples: { type: "string", default: "2" },
      concurrency: { type: "string", default: "3" },
      "max-turns": { type: "string", default: "30" },
      out: { type: "string" },
      baseline: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      context: { type: "boolean", default: false }
    }
  });
  let cases = values.cases !== undefined ? await loadCasesFile(values.cases) : await loadCases(CASES_DIR);
  if (values.case !== undefined) {
    const ids = new Set(values.case.split(",").map((id) => id.trim()));
    const unknown = [...ids].filter((id) => !cases.some((testCase) => testCase.id === id));
    if (unknown.length > 0) throw new Error(`Unknown case: ${unknown.join(", ")}`);
    cases = cases.filter((testCase) => ids.has(testCase.id));
  }
  const effort = values.effort as Flags["effort"];
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Unknown effort ${effort}`);
  return {
    ...(values.account !== undefined ? { account: values.account } : {}),
    appdir: values.appdir ?? resolveBaseDir(homedir(), process.env.ORQUESTER_APPDIR),
    model: values.model!,
    ...(effort !== undefined ? { effort } : {}),
    cases,
    samples: Math.max(1, Number(values.samples)),
    concurrency: Math.max(1, Number(values.concurrency)),
    maxTurns: Math.max(1, Number(values["max-turns"])),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.baseline !== undefined ? { baseline: values.baseline } : {}),
    dryRun: values["dry-run"]!,
    context: values.context!
  };
}

async function loadCasesFile(path: string): Promise<ToolUseCase[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ToolUseCase.parse(JSON.parse(line)));
}

const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

/** `--context`: what the default chat's Orquester text and tools weigh. */
async function printContext(cases: readonly ToolUseCase[]): Promise<void> {
  const variants: [string, ToolUseCase["setup"]["toolsets"]][] = [
    ["base chat", {}],
    ["+ boxes", { boxes: true }],
    ["+ devices", { devices: true }],
    ["+ knowledge", { knowledge: ["Notes"] }]
  ];
  for (const [label, toolsets] of variants) {
    const chat = { ...cases[0]!, setup: { ...cases[0]!.setup, toolsets, workflowOwned: false } };
    const { instructions, tools } = await advertisedFor(chat, "eval", "/tmp/orqeval-context");
    const toolBytes = tools.reduce((sum, tool) => sum + bytes({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }), 0);
    console.log(`${label.padEnd(12)} ${String(tools.length).padStart(3)} tools  ${String(toolBytes).padStart(6)} B tools  ${String(bytes(instructions)).padStart(5)} B instructions  ≈${Math.round((toolBytes + bytes(instructions)) / 4)} tok`);
  }
}

/** `--dry-run`: build every case's chat (manifest, history, mocks) without calling a model. */
async function dryRun(cases: readonly ToolUseCase[]): Promise<void> {
  for (const testCase of cases) {
    const { tools } = await advertisedFor(testCase, "eval", "/tmp/orqeval-dry");
    const names = new Set(tools.map((tool) => tool.name));
    const strays = [
      ...Object.keys(testCase.setup.mocks),
      ...testCase.expect.calls.map((spec) => spec.tool),
      ...testCase.expect.notCalls,
      ...Object.keys(testCase.expect.maxCalls)
    ].filter((tool) => /^[a-z_]+$/.test(tool) && !names.has(tool));
    const history = buildTranscript({ turns: testCase.setup.priorTurns, sessionId: randomUUID(), cwd: "/tmp/orqeval-dry", model: "eval", version: "0", orquesterTools: names });
    console.log(`${testCase.id.padEnd(52)} ${testCase.kind.padEnd(7)} ${String(tools.length).padStart(2)} tools  ${String(history.length).padStart(2)} history lines${strays.length > 0 ? `  NOT ADVERTISED: ${[...new Set(strays)].join(", ")}` : ""}`);
  }
}

function claudeExecutable(): string {
  return execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
}

/** One sample of one case: a fresh cwd and session, graded as it streams. */
async function runSample(testCase: ToolUseCase, sample: number, flags: Flags, account: EvalAccount, executable: string, version: string): Promise<SampleResult> {
  const started = Date.now();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "orqeval-")));
  const projectDir = join(account.home, "projects", claudeProjectSlug(cwd));
  const calls: RecordedCall[] = [];
  const pending = new Map<string, RecordedCall>();
  let finalText = "";
  let costUsd = 0;
  let stoppedEarly = false;
  let error: string | undefined;
  try {
    for (const [path, content] of Object.entries(testCase.setup.files)) {
      const target = join(cwd, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    // The chat's project is a repo on main with the case's files committed, as a real one would be.
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Acme Dev", "-c", "user.email=dev@acme.dev", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "Initial commit");
    const stub = await buildStubServer(testCase, account.id, cwd);
    const sessionId = randomUUID();
    const resume = testCase.setup.priorTurns.length > 0;
    if (resume) {
      const path = claudeTranscriptPath(account.home, cwd, sessionId);
      await mkdir(dirname(path), { recursive: true });
      const lines = buildTranscript({ turns: testCase.setup.priorTurns, sessionId, cwd, model: flags.model, version, orquesterTools: stub.names });
      await writeFile(path, `${lines.join("\n")}\n`);
    }
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !AUTH_ENV.includes(entry[0])));
    env.CLAUDE_CONFIG_DIR = account.home;

    const abort = new AbortController();
    const shellHistory: ShellEntry[] = [];
    const files = Object.keys(testCase.setup.files);
    const guard: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const decision = nativePolicy(testCase, input.tool_name, toolInput, cwd);
      if (decision.decision === "simulate") {
        const output = await simulateShell({ testCase, cwd, files, history: shellHistory, command: decision.command, env, executable, signal: abort.signal }).catch(() => "");
        shellHistory.push({ command: decision.command, output });
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: printing(toolInput, output) } };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.decision,
          ...(decision.decision === "deny" ? { permissionDecisionReason: decision.reason } : {}),
          ...(decision.decision === "allow" && decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {})
        }
      };
    };
    const built = buildClaudeQueryOptions({
      cwd,
      executablePath: executable,
      env,
      runtimeMode: "approval-required",
      modelSelection: { model: flags.model },
      models: [],
      attachmentsDir: cwd,
      canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
      ...(resume ? { resume: sessionId } : { sessionId }),
      sessionTools: {
        server: { type: "sdk", name: SESSION_TOOLS_SERVER_NAME, instance: stub.server },
        instructions: stub.instructions,
        allowedTools: [...stub.names].map((name) => `mcp__${SESSION_TOOLS_SERVER_NAME}__${name}`),
        deny: [],
        names: () => stub.names,
        release: () => undefined
      }
    });
    const options = {
      ...built.options,
      // Isolation: none of the account's CLAUDE.md, skills, plugins, hooks or MCP servers.
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: false,
      agentProgressSummaries: false,
      maxTurns: flags.maxTurns,
      abortController: abort,
      // A simulated shell command waits on a model call.
      hooks: { ...built.options.hooks, PreToolUse: [...(built.options.hooks?.PreToolUse ?? []), { hooks: [guard], timeout: 180 }] },
      ...(flags.effort !== undefined ? { effort: flags.effort } : {})
    };

    const stream = query({ prompt: testCase.prompt, options });
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        const blocks = message.message.content as { type: string; id?: string; text?: string; name?: string; input?: unknown }[];
        const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
        if (text.trim().length > 0) finalText = text;
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;
          const call: RecordedCall = { tool: bareToolName(block.name ?? ""), input: (block.input ?? {}) as Record<string, unknown> };
          calls.push(call);
          if (block.id !== undefined) pending.set(block.id, call);
        }
        if (failedEarly(testCase.expect, { calls, finalText })) {
          stoppedEarly = true;
          abort.abort();
          break;
        }
      } else if (message.type === "user" && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
        for (const block of message.message.content as { type: string; tool_use_id?: string; content?: unknown }[]) {
          const call = block.type === "tool_result" && block.tool_use_id !== undefined ? pending.get(block.tool_use_id) : undefined;
          if (call !== undefined) call.result = resultText(block.content).slice(0, RESULT_CLIP);
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
      }
    }
  } catch (caught) {
    if (!stoppedEarly) error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
  const failures = error === undefined ? gradeSample(testCase.expect, { calls, finalText }) : [];
  return {
    case: testCase.id,
    kind: testCase.kind,
    sample,
    model: flags.model,
    account: account.label,
    pass: error === undefined && failures.length === 0,
    failures,
    stoppedEarly,
    calls,
    finalText,
    costUsd,
    durationMs: Date.now() - started,
    ...(error !== undefined ? { error } : {})
  };
}

/** Run `work` over `items`, at most `limit` at once. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    })
  );
  return results;
}

function summarize(cases: readonly ToolUseCase[], results: readonly SampleResult[], baseline: readonly SampleResult[] | undefined): string {
  const lines = ["| case | kind | pass | samples | failures |", "| --- | --- | --- | --- | --- |"];
  let passed = 0;
  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const testCase of cases) {
    const graded = results.filter((result) => result.case === testCase.id && result.error === undefined);
    const errors = results.filter((result) => result.case === testCase.id && result.error !== undefined).length;
    const pass = casePasses(graded);
    if (pass) passed += 1;
    const failures = [...new Set(graded.flatMap((result) => result.failures))].join("; ");
    lines.push(`| ${testCase.id} | ${testCase.kind} | ${pass ? "yes" : "NO"} | ${graded.filter((r) => r.pass).length}/${graded.length}${errors > 0 ? ` (+${errors} errored)` : ""} | ${failures.replace(/\|/g, "\\|")} |`);
    if (baseline !== undefined) {
      const before = baseline.filter((result) => result.case === testCase.id && result.error === undefined);
      if (before.length === 0) continue;
      if (before.every((result) => result.pass) && !pass) regressions.push(testCase.id);
      if (!casePasses(before) && pass) fixes.push(testCase.id);
    }
  }
  const cost = results.reduce((sum, result) => sum + result.costUsd, 0);
  const head = [`# Tool-use eval: ${results[0]?.model ?? "?"} on ${results[0]?.account ?? "?"}`, "", `${passed} of ${cases.length} cases pass. Notional cost $${cost.toFixed(2)} (billed to the subscription).`, ""];
  if (baseline !== undefined) head.push(`Against the baseline: ${regressions.length} regressed (${regressions.join(", ") || "none"}), ${fixes.length} fixed (${fixes.join(", ") || "none"}).`, "");
  return [...head, ...lines, ""].join("\n");
}

async function main(): Promise<void> {
  // Pre-approved Orquester tools skip canUseTool by design (a chat's launch does the same): the
  // SDK's warning about it would print once per sample.
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error & { code?: string }) => {
    if (warning.code !== "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") console.warn(warning);
  });
  const flags = await readFlags(process.argv.slice(2));
  if (flags.cases.length === 0) throw new Error("No cases.");
  if (flags.context) return printContext(flags.cases);
  if (flags.dryRun) return dryRun(flags.cases);
  if (flags.account === undefined) throw new Error("--account <label or id> is required: a managed Claude account, never the system login.");
  if (flags.out === undefined) throw new Error("--out <dir> is required.");
  const account = await resolveAccount(flags.appdir, flags.account);
  const executable = claudeExecutable();
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).split(" ")[0]!.trim();
  await mkdir(flags.out, { recursive: true });
  const resultsPath = join(flags.out, "results.jsonl");
  console.log(`Running ${flags.cases.length} cases × ${flags.samples} on ${flags.model} as ${account.label} (Claude Code ${version}).`);

  const record = async (result: SampleResult) => {
    await writeFile(resultsPath, `${JSON.stringify(result)}\n`, { flag: "a" });
    console.log(`${result.pass ? "pass" : result.error !== undefined ? "ERR " : "FAIL"} ${result.case} #${result.sample}${result.failures.length > 0 ? `  ${result.failures.join("; ")}` : ""}${result.error !== undefined ? `  ${result.error}` : ""}`);
    return result;
  };
  const jobs = flags.cases.flatMap((testCase) => Array.from({ length: flags.samples }, (_, sample) => ({ testCase, sample })));
  const results = await pool(jobs, flags.concurrency, ({ testCase, sample }) => runSample(testCase, sample, flags, account, executable, version).then(record));
  // T3's rule: a third sample when the first two disagree.
  if (flags.samples === 2) {
    const split = flags.cases.filter((testCase) => {
      const graded = results.filter((result) => result.case === testCase.id && result.error === undefined);
      return graded.length === 2 && graded[0]!.pass !== graded[1]!.pass;
    });
    results.push(...(await pool(split, flags.concurrency, (testCase) => runSample(testCase, 2, flags, account, executable, version).then(record))));
  }
  const baseline =
    flags.baseline !== undefined
      ? (await readFile(flags.baseline, "utf8")).split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as SampleResult)
      : undefined;
  const summary = summarize(flags.cases, results, baseline);
  await writeFile(join(flags.out, "summary.md"), summary);
  console.log(`\n${summary}`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((caught) => {
    console.error(caught instanceof Error ? caught.message : caught);
    process.exit(1);
  });
}
