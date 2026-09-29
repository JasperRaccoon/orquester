import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXPRESSION_PREVIEW_LIMITS, parseExpressionPreviewRequest } from "./expression-preview.ts";
import { MAX_TEMPLATE_LENGTH } from "./expressions.ts";
import { workflowRoutes } from "./types.ts";

describe("parseExpressionPreviewRequest", () => {
  it("reads every field and ignores unknown keys", () => {
    assert.deepEqual(
      parseExpressionPreviewRequest({ templates: ["{{ input }}", "x"], node: "Claude", runId: "run-1", usePinned: true, mode: "value", extra: 1 }),
      { ok: true, request: { templates: ["{{ input }}", "x"], node: "Claude", runId: "run-1", usePinned: true, mode: "value" } }
    );
    assert.deepEqual(parseExpressionPreviewRequest({ templates: [""] }), { ok: true, request: { templates: [""] } });
  });

  it("refuses a body without templates, too many, or a non-text one", () => {
    for (const body of [null, [], "x", {}, { templates: [] }, { templates: "{{ input }}" }]) {
      const parsed = parseExpressionPreviewRequest(body);
      assert.equal(parsed.ok, false, JSON.stringify(body));
    }
    const many = parseExpressionPreviewRequest({ templates: Array.from({ length: EXPRESSION_PREVIEW_LIMITS.maxTemplates + 1 }, () => "x") });
    assert.equal(many.ok, false);
    assert.match(!many.ok ? many.error : "", /at most 20/);
    const typed = parseExpressionPreviewRequest({ templates: ["ok", 3] });
    assert.match(!typed.ok ? typed.error : "", /templates\[1\]/);
  });

  it("refuses a template the renderer would not parse (past MAX_TEMPLATE_LENGTH)", () => {
    assert.equal(EXPRESSION_PREVIEW_LIMITS.maxTemplateLength, MAX_TEMPLATE_LENGTH);
    const parsed = parseExpressionPreviewRequest({ templates: ["x".repeat(MAX_TEMPLATE_LENGTH + 1)] });
    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.error : "", /longer than/);
    assert.equal(parseExpressionPreviewRequest({ templates: ["x".repeat(MAX_TEMPLATE_LENGTH)] }).ok, true);
  });

  it("refuses malformed optional fields", () => {
    for (const extra of [{ node: "" }, { node: 3 }, { runId: "" }, { usePinned: "yes" }, { mode: "raw" }]) {
      assert.equal(parseExpressionPreviewRequest({ templates: ["x"], ...extra }).ok, false, JSON.stringify(extra));
    }
  });

  it("has a route under the workflow", () => {
    assert.equal(workflowRoutes.expressionPreview("a b"), "/api/workflows/a%20b/expression-preview");
  });
});
