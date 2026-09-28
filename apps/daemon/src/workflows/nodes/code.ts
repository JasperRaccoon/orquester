// Automated workflows — the Code block: the user's JavaScript module in the sandbox (spec §4, §5.6).
// input.json = the expression context + the resolved secrets; `stop()` ends the run as stopped; a
// throw fails the block with its message and stack.

import type { NodeExecutor, NodeResult } from "../contracts.ts";
import { describeDuration, runSandboxAttempt } from "./process.ts";

export function createCodeExecutor(): NodeExecutor<"code"> {
  return {
    type: "code",
    async execute(ctx): Promise<NodeResult> {
      const config = ctx.node.config;
      const context = ctx.expressionContext();
      const outcome = await runSandboxAttempt(ctx, {
        kind: "code",
        source: config.source,
        cwd: ctx.project.path,
        env: {},
        input: { ...context, secrets: ctx.secrets },
        ...(config.memoryMb !== undefined ? { memoryMb: config.memoryMb } : {}),
        projectPath: ctx.project.path
      });
      if (outcome.kind === "spawn-failed") {
        return { status: "failed", error: { kind: "internal", message: `The code block could not start: ${outcome.message}` } };
      }
      if (outcome.kind === "lost") {
        return { status: "failed", error: { kind: "interrupted", message: "The code block's process ended without recording a result." } };
      }
      const exit = outcome.exit;
      if (ctx.signal.aborted || exit.cancelled) return { status: "cancelled" };
      const result = exit.result;
      if (result && "stop" in result) {
        return result.reason !== undefined
          ? { status: "stopped", as: "success", message: result.reason }
          : { status: "stopped", as: "success" };
      }
      if (exit.timedOut) {
        return { status: "failed", error: { kind: "timeout", message: `The code block ran past its ${describeDuration(ctx.timeoutMs)} timeout.` } };
      }
      if (result && "ok" in result) {
        if (result.ok) return { status: "succeeded", output: result.value === undefined ? null : result.value };
        const error = result.error;
        return {
          status: "failed",
          error: { kind: "exception", message: error.message, ...(error.stack !== undefined ? { detail: { stack: error.stack } } : {}) }
        };
      }
      if (exit.error !== undefined) return { status: "failed", error: { kind: "internal", message: exit.error } };
      if (exit.interrupted) {
        return { status: "failed", error: { kind: "interrupted", message: "The code block's process was killed before it finished." } };
      }
      if (exit.signal !== null) {
        return {
          status: "failed",
          error: { kind: "interrupted", message: `The code block's process was killed (${exit.signal}) — out of memory?` }
        };
      }
      if (exit.code !== 0 && exit.code !== null) {
        return { status: "failed", error: { kind: "exit_code", message: `The code block exited with code ${exit.code}.` } };
      }
      return { status: "failed", error: { kind: "internal", message: "The code block ended without a result." } };
    }
  };
}
