/**
 * The frozen legacy definitions (unified MCP design 2026-10-15 §14.1) are what the pre-catalog
 * `orquester` server listed — names, schemas, descriptions — and its instruction block. They were
 * held equal to the old toolkits while those existed; with the toolkits deleted (plan Task 14), the
 * copy is pinned by its hash: an old daemon's handlers match only the exact names and argument
 * shapes it was built with, so the copy must never change.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { LEGACY_SECRET_RESULT_KEYS, LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";

/** SHA-256 of the copy as verified equal to the old toolkits' `tools/list` (integration branch c11be4ef). */
const FROZEN_SHA256 = "a2ebf7debbc25253f569fefc1259e7d230ae21925c6e593ed0759d7afe49e68b";

test("the frozen copy is the old server's tools/list, instruction block and secret keys, unchanged", () => {
  const digest = createHash("sha256")
    .update(JSON.stringify([LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS, LEGACY_SECRET_RESULT_KEYS]))
    .digest("hex");
  assert.equal(digest, FROZEN_SHA256, "the legacy definitions are frozen: an old daemon runs handlers for exactly these");
});
