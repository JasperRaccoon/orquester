// Automated workflows — every block executor but the agent's (which the agent module provides).

import type { NodeExecutor, NodeExecutorRegistry } from "../contracts.ts";
import { createCodeExecutor } from "./code.ts";
import { createIfExecutor, createMergeExecutor, createStopExecutor, createSwitchExecutor, createTriggerExecutors } from "./flow.ts";
import { createHttpExecutor, type HttpExecutorOptions } from "./http.ts";
import { createShellExecutor, type ShellExecutorOptions } from "./shell.ts";
import { createSubWorkflowExecutor } from "./subworkflow.ts";
import { createWaitExecutor } from "./wait.ts";

export { createCodeExecutor } from "./code.ts";
export { createIfExecutor, createMergeExecutor, createStopExecutor, createSwitchExecutor, createTriggerExecutors } from "./flow.ts";
export { createHttpExecutor, type HttpExecutorOptions } from "./http.ts";
export { createShellExecutor, type ShellExecutorOptions } from "./shell.ts";
export { createSubWorkflowExecutor } from "./subworkflow.ts";
export { createWaitExecutor } from "./wait.ts";

export interface NodeExecutorsOptions {
  http?: HttpExecutorOptions;
  shell?: ShellExecutorOptions;
  /** The agent block's executor (agent/*); without it an agent block fails "no executor". */
  agent?: NodeExecutor<"agent">;
}

export function createNodeExecutors(options: NodeExecutorsOptions = {}): NodeExecutorRegistry {
  const [manual, schedule, git] = createTriggerExecutors();
  const registry: NodeExecutorRegistry = {
    "trigger.manual": manual,
    "trigger.schedule": schedule,
    "trigger.git": git,
    code: createCodeExecutor(),
    shell: createShellExecutor(options.shell),
    http: createHttpExecutor(options.http),
    if: createIfExecutor(),
    switch: createSwitchExecutor(),
    merge: createMergeExecutor(),
    stop: createStopExecutor(),
    wait: createWaitExecutor(),
    workflow: createSubWorkflowExecutor()
  };
  if (options.agent) registry.agent = options.agent;
  return registry;
}
