import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { testChatTool } from "../../session-tools/testing.ts";
import { ALWAYS_LOAD_META, serializeChatTools } from "./definitions.ts";

test("a tool marked alwaysLoad is advertised with Claude Code's never-defer meta; others carry none", async () => {
  const [loaded, deferred] = await serializeChatTools([
    { ...testChatTool({ name: "always_here", input: {}, run: async () => ({}) }), alwaysLoad: true },
    testChatTool({ name: "on_demand", input: {}, run: async () => ({}) })
  ]);
  assert.deepEqual(loaded!._meta, { [ALWAYS_LOAD_META]: true });
  assert.equal(deferred!._meta, undefined);
});

test("serialized tools preserve argument names that are JSON Schema keywords", async () => {
  const [entry] = await serializeChatTools([
    testChatTool({
      name: "keyword_fields",
      input: {
        $schema: z.string(),
        nested: z.object({ $schema: z.string() })
      },
      run: async () => ({})
    })
  ]);
  const schema = entry!.inputSchema;
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["$schema", "nested"]);
  assert.deepEqual(schema.required, ["$schema", "nested"]);
  const nested = schema.properties!.nested as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(nested.properties), ["$schema"]);
  assert.deepEqual(nested.required, ["$schema"]);
});
