import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { testChatTool } from "../../session-tools/testing.ts";
import { serializeChatTools } from "./definitions.ts";

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
