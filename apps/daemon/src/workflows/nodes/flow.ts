// Automated workflows — the flow blocks: IF, Switch, Merge, Stop, and the triggers (spec §3.2, §4).
// Pure: they read the run context and choose a handle.

import { evaluateRules, evaluateSwitch, type ExpressionContext, type WorkflowNodeType } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeResult } from "../contracts.ts";

function ruleContext<T extends WorkflowNodeType>(ctx: NodeExecutionContext<T>): ExpressionContext {
  return { ...ctx.expressionContext(), secrets: ctx.secrets, workflow: { id: ctx.workflow.id, name: ctx.workflow.name } };
}

/** A trigger's output is the event that fired the run (§6). */
export function createTriggerExecutors(): [NodeExecutor<"trigger.manual">, NodeExecutor<"trigger.schedule">, NodeExecutor<"trigger.git">] {
  const make = <T extends "trigger.manual" | "trigger.schedule" | "trigger.git">(type: T): NodeExecutor<T> => ({
    type,
    execute: async (ctx) => ({ status: "succeeded", output: ctx.expressionContext().trigger ?? null })
  });
  return [make("trigger.manual"), make("trigger.schedule"), make("trigger.git")];
}

export function createIfExecutor(): NodeExecutor<"if"> {
  return {
    type: "if",
    async execute(ctx): Promise<NodeResult> {
      const context = ruleContext(ctx);
      const evaluated = evaluateRules(ctx.node.config.combine, ctx.node.config.rules, context);
      return { status: "succeeded", output: context.input, handle: evaluated.result ? "true" : "false", warnings: evaluated.warnings };
    }
  };
}

export function createSwitchExecutor(): NodeExecutor<"switch"> {
  return {
    type: "switch",
    async execute(ctx): Promise<NodeResult> {
      const context = ruleContext(ctx);
      const evaluated = evaluateSwitch(ctx.node.config, context);
      // No case and no fallback output: every outgoing edge is dead.
      return { status: "succeeded", output: context.input, handle: evaluated.handle ?? "none", warnings: evaluated.warnings };
    }
  };
}

/** `{[nodeName]: output}` of every branch that arrived ("first" mode runs on the first arrival). */
export function createMergeExecutor(): NodeExecutor<"merge"> {
  return {
    type: "merge",
    async execute(ctx): Promise<NodeResult> {
      const output: Record<string, unknown> = {};
      for (const input of ctx.liveInputs?.() ?? []) output[input.name] = input.output ?? null;
      return { status: "succeeded", output };
    }
  };
}

/** Ends the run; its rendered value becomes the run's final output. */
export function createStopExecutor(): NodeExecutor<"stop"> {
  return {
    type: "stop",
    async execute(ctx): Promise<NodeResult> {
      const config = ctx.node.config;
      const output = config.value !== undefined && config.value.trim().length > 0 ? ctx.renderValue(config.value).value : ctx.expressionContext().input;
      const message = config.message !== undefined && config.message.trim().length > 0 ? ctx.render(config.message).text : undefined;
      return message !== undefined
        ? { status: "stopped", as: config.as, message, output }
        : { status: "stopped", as: config.as, output };
    }
  };
}
