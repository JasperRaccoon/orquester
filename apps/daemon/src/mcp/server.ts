import type { FastifyInstance } from "fastify";

/**
 * Placeholder while the MCP surface is rebuilt chat-native (MCP v2): the v1
 * terminal tools are gone, and nothing is mounted at `/mcp` until the v2
 * server replaces this module.
 */
export interface McpDeps {}

export function registerMcp(_app: FastifyInstance, _deps: McpDeps): void {}
