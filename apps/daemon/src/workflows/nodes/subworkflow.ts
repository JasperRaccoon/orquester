// Automated workflows — the Run workflow block (spec §4): a child run of another workflow, linked
// both ways, depth ≤ 5, cycles refused. Its output is the child's final output; a child that does
// not succeed fails the block with `child_run_failed`. Resumable through the `child-run` WaitingOn.

import type { NodeExecutor, NodeResult } from "../contracts.ts";
import { WorkflowEngineError } from "../run-context.ts";
import { describeDuration } from "./process.ts";

export function createSubWorkflowExecutor(): NodeExecutor<"workflow"> {
  return {
    type: "workflow",
    async execute(ctx): Promise<NodeResult> {
      const clock = ctx.services.clock;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      let timer: { cancel(): void } | null = null;
      if (Number.isFinite(ctx.timeoutMs)) {
        const left = Date.parse(ctx.startedAt) + ctx.timeoutMs - clock.now().getTime();
        timer = clock.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.max(0, left));
      }
      try {
        let result;
        if (ctx.resumeFrom?.kind === "child-run") {
          ctx.update({ childRunId: ctx.resumeFrom.runId });
          result = await ctx.services.awaitRun(ctx.resumeFrom.runId, controller.signal);
        } else {
          const config = ctx.node.config;
          const input =
            config.input !== undefined && config.input.trim().length > 0 ? ctx.renderValue(config.input).value : ctx.expressionContext().input;
          let started;
          try {
            started = await ctx.services.runChild({
              workflowId: config.workflowId,
              input: input ?? null,
              parentRunId: ctx.runId,
              parentNodeId: ctx.node.id,
              depth: ctx.depth,
              signal: controller.signal
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const kind = error instanceof WorkflowEngineError && error.code === "LIMIT_EXCEEDED" ? "limit_exceeded" : "validation";
            return { status: "failed", error: { kind, message } };
          }
          await ctx.setWaitingOn({ kind: "child-run", runId: started.runId });
          ctx.update({ childRunId: started.runId });
          result = await started.wait;
        }
        await ctx.setWaitingOn(undefined);
        if (result.status === "succeeded" || result.status === "stopped") {
          return { status: "succeeded", output: result.finalOutput === undefined ? null : result.finalOutput };
        }
        if (timedOut) {
          return { status: "failed", error: { kind: "timeout", message: `The sub-workflow did not finish within ${describeDuration(ctx.timeoutMs)}.` } };
        }
        if (ctx.signal.aborted) return { status: "cancelled" };
        const failure: Extract<NodeResult, { status: "failed" }> = {
          status: "failed",
          error: {
            kind: "child_run_failed",
            message: `The sub-workflow "${result.workflowName}" ${result.status}${result.error ? `: ${result.error}` : "."}`,
            detail: { runId: result.id, status: result.status }
          }
        };
        if (result.finalOutput !== undefined) failure.output = result.finalOutput;
        return failure;
      } finally {
        timer?.cancel();
        ctx.signal.removeEventListener("abort", onAbort);
      }
    }
  };
}
