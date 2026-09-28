// Automated workflows — the Shell block (spec §4, §5.6). The script is NEVER rendered: values reach
// it only through `env`, whose values are templates (secrets allowed). Exit 0 = success. The output
// is `{stdout, stderr, exitCode}`: each stream's tail within half the output cap, redacted.

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { WORKFLOW_LIMITS } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeResult } from "../contracts.ts";
import { readLogWindow } from "../sandbox/log-reader.ts";
import { createRedactor } from "../sandbox/redact.ts";
import { tailUtf8 } from "../run-context.ts";
import { describeDuration, runSandboxAttempt } from "./process.ts";

export interface ShellExecutorOptions {
  /** The whole output's cap; each stream's tail gets half of it minus a margin. */
  maxOutputBytes?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The redacted tail of a log within `maxBytes`, and whether it was cut. */
async function readTail(path: string, maxBytes: number, secrets: Record<string, string>): Promise<{ text: string; cut: boolean }> {
  const size = await fileSize(path);
  if (size === 0) return { text: "", cut: false };
  const redactor = createRedactor(secrets);
  const from = Math.max(0, size - maxBytes);
  const window = await readLogWindow(path, from, maxBytes, redactor);
  return { text: window.text, cut: from > 0 };
}

export function createShellExecutor(options: ShellExecutorOptions = {}): NodeExecutor<"shell"> {
  const maxOutputBytes = options.maxOutputBytes ?? WORKFLOW_LIMITS.maxOutputBytes;
  // Half the cap per stream, less room for the JSON around them (spec §3.2).
  const tailBytes = Math.max(1024, Math.floor(maxOutputBytes / 2) - 4096);

  const collect = async (
    ctx: NodeExecutionContext<"shell">,
    attemptDir: string,
    exitCode: number | null
  ): Promise<{ output: { stdout: string; stderr: string; exitCode: number | null }; warnings: string[] }> => {
    const [stdout, stderr] = await Promise.all([
      readTail(join(attemptDir, "stdout.log"), tailBytes, ctx.secrets),
      readTail(join(attemptDir, "stderr.log"), tailBytes, ctx.secrets)
    ]);
    const warnings: string[] = [];
    let out = stdout.text;
    let err = stderr.text;
    // JSON escaping can grow a text past the cap (control characters): cut further until it fits.
    for (let budget = tailBytes; budget > 1024; budget = Math.floor(budget / 2)) {
      if (Buffer.byteLength(JSON.stringify({ stdout: out, stderr: err, exitCode }), "utf8") <= maxOutputBytes) break;
      out = tailUtf8(out, Math.floor(budget / 2));
      err = tailUtf8(err, Math.floor(budget / 2));
      stdout.cut = true;
      stderr.cut = true;
    }
    if (stdout.cut) warnings.push("stdout was cut to its tail; the whole log is kept.");
    if (stderr.cut) warnings.push("stderr was cut to its tail; the whole log is kept.");
    return { output: { stdout: out, stderr: err, exitCode }, warnings };
  };

  return {
    type: "shell",
    async execute(ctx): Promise<NodeResult> {
      const config = ctx.node.config;
      const env: Record<string, string> = {};
      if (ctx.resumeFrom?.kind !== "process") {
        for (const entry of config.env) {
          if (!ENV_NAME.test(entry.name)) {
            return { status: "failed", error: { kind: "validation", message: `"${entry.name}" is not a valid environment variable name.` } };
          }
          const rendered = ctx.render(entry.value);
          if (rendered.text.includes("\0")) {
            return { status: "failed", error: { kind: "expression", message: `The value of ${entry.name} contains a NUL byte.` } };
          }
          env[entry.name] = rendered.text;
        }
      }
      const attemptDir = ctx.resumeFrom?.kind === "process" ? ctx.resumeFrom.attemptDir : await ctx.attemptDir();
      const outcome = await runSandboxAttempt(ctx, {
        kind: "shell",
        source: config.script,
        shell: config.shell,
        cwd: ctx.project.path,
        env,
        projectPath: ctx.project.path
      });
      if (outcome.kind === "spawn-failed") {
        return { status: "failed", error: { kind: "internal", message: `The shell block could not start: ${outcome.message}` } };
      }
      if (ctx.signal.aborted) return { status: "cancelled" };
      if (outcome.kind === "lost") {
        const { output, warnings } = await collect(ctx, attemptDir, null);
        void warnings;
        return { status: "failed", error: { kind: "interrupted", message: "The shell block's process ended without recording its exit." }, output };
      }
      const exit = outcome.exit;
      const { output, warnings } = await collect(ctx, attemptDir, exit.code);
      // The run did not cancel it (checked above): a runner stopped from outside is a failure.
      if (exit.cancelled) {
        return { status: "failed", error: { kind: "interrupted", message: "The script was stopped from outside the workflow." }, output };
      }
      if (exit.timedOut) {
        return { status: "failed", error: { kind: "timeout", message: `The shell block ran past its ${describeDuration(ctx.timeoutMs)} timeout.` }, output };
      }
      if (exit.error !== undefined) return { status: "failed", error: { kind: "internal", message: exit.error }, output };
      if (exit.code === 0) return warnings.length > 0 ? { status: "succeeded", output, warnings } : { status: "succeeded", output };
      if (exit.code !== null) {
        return { status: "failed", error: { kind: "exit_code", message: `The script exited with code ${exit.code}.` }, output };
      }
      return {
        status: "failed",
        error: { kind: "interrupted", message: `The script was killed${exit.signal ? ` (${exit.signal})` : ""}.` },
        output
      };
    }
  };
}
