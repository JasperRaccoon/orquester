import assert from "node:assert/strict";
import { test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serializeChatTools } from "../../agent-host/session-tools/definitions.ts";
import { audienceSchema, audienceShape } from "../executor.ts";
import { catalogFor } from "./index.ts";

// A zod schema instance used by two fields of one tool is listed by the SDK as a JSON-schema "$ref"
// to the first field ("#/properties/similarTo"). Claude Code does not follow such refs: it sends
// the value as a string and the call is refused ("Expected array, received string"). Build a
// schema used twice with a factory (`() => z...`) instead of sharing one instance.

function refs(value: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => refs(item, `${path}[${index}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") out.push(`${path || "(root)"} → ${String(child)}`);
      else refs(child, `${path}.${key}`, out);
    }
  }
  return out;
}

test("no chat tool's input schema holds a $ref", async () => {
  const offenders = (await serializeChatTools(catalogFor("chat")))
    .map((tool) => ({ name: tool.name, refs: refs(tool.inputSchema, "", []) }))
    .filter((tool) => tool.refs.length > 0);
  assert.deepEqual(offenders, []);
});

test("no external tool's input schema holds a $ref", async () => {
  const server = new McpServer({ name: "schema-refs", version: "test" });
  for (const tool of catalogFor("external")) {
    const shape = audienceShape(tool, "external");
    server.registerTool(tool.name, { description: tool.description, inputSchema: Object.keys(shape).length > 0 ? shape : audienceSchema(tool, "external") }, () => ({ content: [] }));
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-refs", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const offenders = (await client.listTools()).tools
      .map((tool) => ({ name: tool.name, refs: refs(tool.inputSchema, "", []) }))
      .filter((tool) => tool.refs.length > 0);
    assert.deepEqual(offenders, []);
  } finally {
    await client.close();
    await server.close();
  }
});
