/**
 * The profile detail's settings as the shared UI keeps them: the Knowledge Graph plugin's
 * `knowledgeCollections` survives (ids only), is absent from an older daemon, and a bad value
 * never reaches state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeSessionProfileDetail } from "./sanitize.ts";

const detail = (settings: unknown) =>
  sanitizeSessionProfileDetail({ id: "p1", name: "SaaS", description: "", revision: "1", createdAt: "t", updatedAt: "t", settings, items: [] })!.settings;

test("settings.knowledgeCollections: ids kept (deduplicated), absent stays absent, junk dropped", () => {
  assert.deepEqual(detail({ claudeWorkflowTool: true, knowledgeCollections: ["kc_seo0000000", "kc_seo0000000", 3, "a b", "kc_ads0000000"] }).knowledgeCollections, ["kc_seo0000000", "kc_ads0000000"]);
  assert.equal("knowledgeCollections" in detail({ claudeWorkflowTool: false }), false, "an older daemon: none ticked");
  assert.equal("knowledgeCollections" in detail({ knowledgeCollections: "all" }), false);
  assert.deepEqual(detail({ knowledgeCollections: [] }).knowledgeCollections, []);
});
