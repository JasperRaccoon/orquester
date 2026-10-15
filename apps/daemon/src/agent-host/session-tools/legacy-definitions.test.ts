/**
 * The frozen legacy definitions (unified MCP design 2026-10-15 §14.1) are what the pre-catalog
 * `orquester` server listed — names, schemas, descriptions — and its instruction block, held equal
 * to the old toolkits while those still exist (plan Task 14 deletes both). And the catalog's chat
 * tools are serialised for the host exactly as the executor shapes them for the chat audience.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogFor } from "../../mcp/catalog/index.ts";
import { legacyChatTools } from "../../mcp/catalog/legacy.ts";
import { audienceDescription, audienceShape } from "../../mcp/executor.ts";
import { sessionToolRegistry } from "../../session-tools/index.ts";
import { buildChatToolDefinitions, chatDescription, chatShape, knownSessionToolNames, serializeChatTools } from "./definitions.ts";
import { LEGACY_SECRET_RESULT_KEYS, LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

test("the frozen copy is the old server's tools/list, instruction block and secret keys", async () => {
  const registry = sessionToolRegistry();
  assert.deepEqual(json(await serializeChatTools(legacyChatTools(registry.tools))), json(LEGACY_SESSION_TOOL_DEFINITIONS));
  assert.equal(LEGACY_SESSION_TOOL_INSTRUCTIONS, registry.instructions);
  assert.deepEqual(
    LEGACY_SECRET_RESULT_KEYS,
    Object.fromEntries(registry.tools.filter((tool) => tool.secretResultKeys?.length).map((tool) => [tool.name, tool.secretResultKeys]))
  );
  assert.equal(LEGACY_SESSION_TOOL_DEFINITIONS.length, 16);
});

test("the host shapes every chat tool as the executor does for the chat audience", () => {
  for (const tool of catalogFor("chat")) {
    assert.deepEqual(Object.keys(chatShape(tool)), Object.keys(audienceShape(tool, "chat")), tool.name);
    assert.equal(chatDescription(tool), audienceDescription(tool, "chat"), tool.name);
  }
});

test("the definitions: the catalog's chat tools first, then the legacy names the catalog lacks; every name is known", async () => {
  const definitions = await buildChatToolDefinitions();
  assert.deepEqual(definitions.catalogNames, catalogFor("chat").map((tool) => tool.name));
  const known = knownSessionToolNames();
  for (const name of [...definitions.catalogNames, ...definitions.legacyNames]) {
    assert.ok(definitions.byName.has(name), name);
    assert.ok(known.has(name), name);
  }
  // request_secret's value is masked by the host (its secret keys travel with its definition).
  assert.deepEqual(definitions.byName.get("request_secret")?.secretResultKeys, ["value"]);
});
