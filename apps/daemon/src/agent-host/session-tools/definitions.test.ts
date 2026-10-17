import assert from "node:assert/strict";
import test from "node:test";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { compactToolEntry } from "./definitions.ts";

test("compactToolEntry drops execution, $schema, closed/empty additionalProperties, minLength 1 and big maxLength, never a field name", () => {
  const entry = {
    name: "t",
    description: "d",
    execution: { taskSupport: "forbidden" },
    inputSchema: {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      required: ["a"],
      properties: {
        a: { type: "string", minLength: 1, maxLength: 9 },
        b: { type: "string", minLength: 2 },
        big: { type: "string", maxLength: 4096 },
        c: { type: "object", additionalProperties: {} },
        d: { type: "object", additionalProperties: { type: "string" } },
        minLength: { type: "integer" },
        additionalProperties: { type: "object", additionalProperties: false }
      }
    }
  } as unknown as Tool;
  assert.deepEqual(compactToolEntry(entry), {
    name: "t",
    description: "d",
    inputSchema: {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", maxLength: 9 },
        b: { type: "string", minLength: 2 },
        big: { type: "string" },
        c: { type: "object" },
        d: { type: "object", additionalProperties: { type: "string" } },
        minLength: { type: "integer" },
        additionalProperties: { type: "object" }
      }
    }
  });
});
