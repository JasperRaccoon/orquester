/**
 * The frozen legacy definitions (unified MCP design 2026-10-15 §14.1) are what the pre-catalog
 * `orquester` server listed — names, schemas, descriptions — and its instruction block. They were
 * held equal to the old toolkits while those existed; with the toolkits deleted (plan Task 14), the
 * copy is pinned by its hash: an old daemon's handlers match only the exact names and argument
 * shapes it was built with, so the copy must never change. And the catalog's chat tools are
 * serialised for the host exactly as the executor shapes them for the chat audience.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { catalogFor } from "../../mcp/catalog/index.ts";
import { audienceDescription, audienceShape } from "../../mcp/executor.ts";
import { buildChatToolDefinitions, chatDescription, chatShape, knownSessionToolNames } from "./definitions.ts";
import { LEGACY_SECRET_RESULT_KEYS, LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";

/** SHA-256 of the copy as verified equal to the old toolkits' `tools/list` (integration branch c11be4ef). */
const FROZEN_SHA256 = "a2ebf7debbc25253f569fefc1259e7d230ae21925c6e593ed0759d7afe49e68b";

test("the frozen copy is the old server's tools/list, instruction block and secret keys, unchanged", () => {
  const digest = createHash("sha256")
    .update(JSON.stringify([LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS, LEGACY_SECRET_RESULT_KEYS]))
    .digest("hex");
  assert.equal(digest, FROZEN_SHA256, "the legacy definitions are frozen: an old daemon runs handlers for exactly these");
  assert.deepEqual(
    LEGACY_SESSION_TOOL_DEFINITIONS.map((entry) => entry.name),
    ["html_preview", "html_render", "request_secret", "thread_list", "thread_read", "thread_create", "agent_catalog", "thread_send", "thread_wait", "thread_interrupt", "thread_fork", "thread_merge_back", "delegate_task", "task_status", "task_wait", "task_cancel"]
  );
  assert.deepEqual(LEGACY_SECRET_RESULT_KEYS, { request_secret: ["value"] });
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
