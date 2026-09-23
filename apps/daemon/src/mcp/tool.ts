import type { z } from "zod";
import type { DaemonApi } from "./daemon-api.ts";
import type { TodoTools } from "./todo-tools.ts";
import type { FsTools } from "./fs-tools.ts";

export interface ToolContext {
  api: DaemonApi;
  todos: TodoTools;
  files: FsTools;
  /** Aborted when the MCP request closes; every wait must honour it. */
  signal: AbortSignal;
  now: () => number;
}

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }

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
 * `openWorldHint: false` says a tool touches only the daemon's own state. A read qualifies, as do the todo and file
 * tools; a tool that drives an agent does not — the agent it drives can reach anything — so it keeps the default (true).
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
export const MUTATING: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const MUTATING_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
/** A write that stays inside the daemon's own state (the todo store): the same hints, and no open world. */
export const closedWorld = (annotations: ToolAnnotations): ToolAnnotations => ({ ...annotations, openWorldHint: false });
