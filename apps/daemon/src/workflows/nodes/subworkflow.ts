// Automated workflows — the Run workflow block (spec §4): a child run of another workflow, linked
// both ways, depth ≤ 5, cycles refused. Its output is the child's final output; a child that does
// not succeed fails the block with `child_run_failed`. Resumable through the `child-run` WaitingOn.

import { createPromptTrust, templateReferences } from "@orquester/api";
import type { NodeExecutionContext, NodeExecutor, NodeResult } from "../contracts.ts";
import { ChildRunUnknownError, EngineStoppedError, WorkflowEngineError } from "../run-context.ts";
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
        const startedAt = ctx.startedAt !== undefined ? Date.parse(ctx.startedAt) : clock.now().getTime();
        const left = startedAt + ctx.timeoutMs - clock.now().getTime();
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
          const templated = config.input !== undefined && config.input.trim().length > 0;
          const input = templated ? ctx.renderValue(config.input!).value : ctx.expressionContext().input;
          const untrusted = passesUntrusted(ctx, templated ? config.input! : null);
          let started;
          try {
            started = await ctx.services.runChild({
              workflowId: config.workflowId,
              input: input ?? null,
              parentRunId: ctx.runId,
              parentNodeId: ctx.node.id,
              depth: ctx.depth,
              signal: controller.signal,
              // One child per attempt: asking again (a resumed attempt) returns the same run.
              attempt: ctx.attempt,
              ...(untrusted ? { untrusted: true } : {})
            });
          } catch (error) {
            // The engine is stopping: no child started, and none may — the block resumes (and starts
            // its child) after the restart; never a validation failure.
            if (error instanceof WorkflowEngineError && error.code === "ENGINE_UNAVAILABLE") throw new EngineStoppedError();
            const message = error instanceof Error ? error.message : String(error);
            // Only a definition the child cannot run is a validation failure: not knowing whether this
            // attempt's child exists (or one being started) is an interruption, never retried.
            if (error instanceof ChildRunUnknownError) {
              return { status: "failed", error: { kind: "interrupted", message, detail: { childRunUnknown: true } } };
            }
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

/**
 * Whether the child's input may carry text someone else wrote (`@orquester/api` prompt-safety.ts):
 * its template reads untrusted data, or (no template) the block's own input is. The child then
 * frames it in its agent prompts.
 */
function passesUntrusted(ctx: NodeExecutionContext<"workflow">, template: string | null): boolean {
  const trust = createPromptTrust({
    workflow: ctx.workflow,
    nodeId: ctx.node.id,
    trigger: ctx.expressionContext().trigger,
    liveInputs: ctx.liveInputs?.() ?? []
  });
  if (template === null) return trust("input", []);
  return templateReferences(template).some((ref) => trust(ref.root, ref.path));
}
