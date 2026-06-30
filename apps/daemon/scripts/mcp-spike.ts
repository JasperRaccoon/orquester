/**
 * One-off MCP protocol validation spike (PLAN Task 1, steps 5-7).
 *
 * This is NOT part of the daemon and is never imported by it. It stands up a
 * stateless Streamable-HTTP MCP server with a single `ping` tool so you can
 * confirm, BEFORE relying on /mcp, that:
 *   (1) a stateless server + enableJsonResponse answers initialize + tools/list
 *       over plain JSON when the client sends `Accept: application/json,
 *       text/event-stream` (and 406s without it), and
 *   (2) your real target client (mcp-inspector / Claude Code / Claude Desktop)
 *       connects to a stateless server (vs. demanding an Mcp-Session-Id handshake,
 *       which would mean /mcp needs the stateful session-map mount instead).
 *
 * RUN IT IN A SEPARATE CHECKOUT — never inside a live Orquester checkout. It binds
 * a throwaway port (default 47999), NOT the daemon port:
 *
 *   node --import tsx apps/daemon/scripts/mcp-spike.ts
 *
 *   curl -sS -X POST http://127.0.0.1:47999/mcp \
 *     -H 'Content-Type: application/json' \
 *     -H 'Accept: application/json, text/event-stream' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
 *
 *   # then tools/list, and repeat initialize WITHOUT the event-stream Accept → expect 406
 */
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.SPIKE_PORT ?? 47999); // NOT the daemon port (47831)
const app = Fastify();

app.post("/mcp", async (request, reply) => {
  const server = new McpServer({ name: "spike", version: "0.0.0" });
  server.registerTool(
    "ping",
    { description: "returns pong", inputSchema: { msg: z.string().optional() } },
    async (args) => ({ content: [{ type: "text", text: `pong ${args.msg ?? ""}` }] })
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  reply.hijack();
  reply.raw.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request.raw, reply.raw, request.body);
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`mcp-spike on http://127.0.0.1:${PORT}/mcp`);
