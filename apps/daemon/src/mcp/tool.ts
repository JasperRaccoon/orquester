import type { z } from "zod";
import type { ComposerContextRecord } from "@orquester/api/agent-chat";
import type { DaemonApi } from "./daemon-api.ts";
import type { TodoTools } from "./todo-tools.ts";
import type { FsTools } from "./fs-tools.ts";
import type { ToolAnnotations } from "./catalog/contract.ts";

export interface ToolContext {
  api: DaemonApi;
  todos: TodoTools;
  files: FsTools;
  /** Aborted when the MCP request closes; every wait must honour it. */
  signal: AbortSignal;
  now: () => number;
  /**
   * In-daemon callers only (the session tools reusing a handler): context chips a `/turn` this
   * handler posts carries (`TurnCommandBody.context`) — the marker that says Orquester authored the
   * message. Never set for an external MCP client, which cannot reach it.
   */
  turnContext?: readonly ComposerContextRecord[];
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/**
 * The annotation presets and `ToolAnnotations` now live with the catalog contract
 * (`./catalog/contract.ts`, unified MCP design 2026-10-15 §3.2); re-exported here for the
 * pre-catalog `ToolDef`s, which Task 14 removes with this shim.
 */
export { closedWorld, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY } from "./catalog/contract.ts";
export type { ToolAnnotations } from "./catalog/contract.ts";
