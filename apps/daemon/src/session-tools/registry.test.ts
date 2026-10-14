/**
 * The session-tool registry and the instruction block (design 2026-10-14
 * §1.1, §1.4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { defineSessionTool, defineSessionToolkit, SESSION_TOOL_READ_ONLY, type SessionToolkit } from "./contract.ts";
import { SESSION_TOOLKITS, sessionToolRegistry } from "./index.ts";
import {
  composeSessionToolInstructions,
  createSessionToolRegistry,
  SESSION_TOOL_INSTRUCTIONS_MAX_BYTES
} from "./registry.ts";
import { EXTERNAL_MCP_TOOL_NAMES } from "../mcp/tool-names.ts";
import { externalMcpToolNames } from "../mcp/server.ts";
import { jsonResult } from "./results.ts";
import { TEST_TOOLKIT_INSTRUCTIONS, testSessionToolkit, testSessionToolRegistry } from "./testing.ts";

const toolkit = (id: string, names: string[], instructions?: string): SessionToolkit =>
  defineSessionToolkit({
    id,
    ...(instructions !== undefined ? { instructions } : {}),
    tools: names.map((name) =>
      defineSessionTool({
        name,
        title: name,
        description: name,
        input: { x: z.string().optional() },
        annotations: SESSION_TOOL_READ_ONLY,
        resultKind: "json",
        run: async () => jsonResult({})
      })
    )
  });

test("production registers its toolkits, within the instruction budget", () => {
  assert.deepEqual(
    SESSION_TOOLKITS.map((entry) => entry.id),
    ["secrets"]
  );
  const registry = sessionToolRegistry();
  assert.equal(registry.enabled, true);
  assert.ok(registry.get("request_secret"));
  assert.match(registry.instructions, /^## Orquester\n/);
  assert.ok(registry.instructions.includes("`request_secret`"));
  assert.ok(Buffer.byteLength(registry.instructions) <= SESSION_TOOL_INSTRUCTIONS_MAX_BYTES);
});

test("an empty toolkit list attaches no server", () => {
  const registry = createSessionToolRegistry([]);
  assert.equal(registry.enabled, false);
  assert.equal(registry.instructions, "");
  assert.equal(registry.tools.length, 0);
});

test("the test toolkit registers and composes its paragraph after the header", () => {
  const registry = testSessionToolRegistry();
  assert.equal(registry.enabled, true);
  assert.deepEqual(
    registry.tools.map((tool) => tool.name),
    testSessionToolkit.tools.map((tool) => tool.name)
  );
  assert.equal(registry.get("echo")?.name, "echo");
  assert.equal(registry.get("nope"), undefined);
  assert.match(registry.instructions, /^## Orquester\n/);
  assert.ok(registry.instructions.includes("`orquester` MCP server"));
  assert.ok(registry.instructions.endsWith(TEST_TOOLKIT_INSTRUCTIONS));
  assert.ok(Buffer.byteLength(registry.instructions) <= SESSION_TOOL_INSTRUCTIONS_MAX_BYTES);
});

test("a toolkit without tools contributes nothing; none at all composes to empty", () => {
  assert.equal(composeSessionToolInstructions([]), "");
  assert.equal(composeSessionToolInstructions([toolkit("empty", [], "never shown")]), "");
  const composed = composeSessionToolInstructions([toolkit("a", ["one"], "A says."), toolkit("b", ["two"])]);
  assert.ok(composed.endsWith("A says."));
});

test("bad and duplicate names, and bad toolkit ids, are refused at build", () => {
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["Bad-Name"])]), /bad tool name/);
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["one"]), toolkit("b", ["one"])]), /duplicate tool name/);
  assert.throws(() => createSessionToolRegistry([toolkit("A", ["one"])]), /toolkit id/);
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["one"]), toolkit("a", ["two"])]), /toolkit id/);
});

test("an instruction block over the cap is refused, never cut", () => {
  const long = "x".repeat(SESSION_TOOL_INSTRUCTIONS_MAX_BYTES);
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["one"], long)]), /over the 1536-byte cap/);
});

test("a session tool may not take an external /mcp tool's name", () => {
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["send_message"])]), /external \/mcp tool's name/);
  assert.throws(() => createSessionToolRegistry([toolkit("a", ["list_sessions"])]), /external \/mcp tool's name/);
});

test("the reserved list is exactly the external /mcp catalogue", () => {
  assert.deepEqual([...EXTERNAL_MCP_TOOL_NAMES].sort(), externalMcpToolNames().sort());
});
