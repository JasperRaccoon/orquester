/**
 * `request_secret` results without their value (design 2026-10-14 §5
 * "Secrets"): the structural strip, wherever a provider keeps the result.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSecretRequestSummary,
  SECRET_REDACTED_TEXT,
  secretRequestRecordOf,
  stripSecretRequestValues
} from "./secret-requests.ts";
import { projectSessionToolData } from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";

const VALUE = "s3cr3t-value-0042";
const record = { name: "API_KEY", purpose: "Deploy", outcome: "provided" };
const result = { secretRequest: record, value: VALUE, note: "Use it; never print it." };
const text = JSON.stringify(result);

const holds = (value: unknown): boolean => JSON.stringify(value).includes(VALUE);

test("the value is dropped from every provider's record of the result", () => {
  const shapes: Record<string, unknown> = {
    // Claude: the tool_result block, content as blocks or a bare string.
    claudeBlocks: { toolName: "mcp__orquester__request_secret", result: { type: "tool_result", content: [{ type: "text", text }] } },
    claudeString: { toolName: "mcp__orquester__request_secret", result: { type: "tool_result", content: text } },
    // Codex: the CallToolResult, text and structuredContent both.
    codex: { server: "orquester", tool: "request_secret", result: { content: [{ type: "text", text }], structuredContent: result } },
    // Grok: ACP content wrappers and a structured rawOutput.
    grok: {
      vendorTool: "orquester__request_secret",
      content: [{ type: "content", content: { type: "text", text } }],
      rawOutput: { type: "Mcp", ...result }
    },
    // OpenCode: the output text.
    opencode: { tool: "orquester-0123456789abcdef_request_secret", result: text },
    // Pretty-printed JSON is still JSON.
    pretty: { output: JSON.stringify(result, null, 2) }
  };
  for (const [name, shape] of Object.entries(shapes)) {
    assert.ok(holds(shape), `${name}: the fixture carries the value`);
    const stripped = stripSecretRequestValues(shape);
    assert.ok(!holds(stripped), `${name}: no value left`);
    assert.ok(JSON.stringify(stripped).includes("API_KEY"), `${name}: the record stays`);
  }
});

test("a doubly serialised copy — a stringified content array — loses the value too", () => {
  const contentArray = JSON.stringify([{ type: "text", text }]);
  assert.ok(contentArray.includes("\\\"secretRequest\\\""), "escaped: no quoted marker in it");
  const shapes = [contentArray, { output: contentArray }, JSON.stringify(contentArray), JSON.stringify({ result: contentArray })];
  for (const shape of shapes) {
    assert.ok(holds(shape));
    const stripped = stripSecretRequestValues(shape);
    assert.ok(!holds(stripped), JSON.stringify(shape).slice(0, 60));
    assert.ok(JSON.stringify(stripped).includes("API_KEY"), "parsed and rewritten, not dropped");
  }
});

test("past the depth bound nothing is passed through unchecked", () => {
  let deep: unknown = { secretRequest: record, value: VALUE };
  for (let i = 0; i < 80; i += 1) deep = { inner: deep };
  assert.ok(!holds(stripSecretRequestValues(deep)));
  let deepText: unknown = text;
  for (let i = 0; i < 80; i += 1) deepText = [deepText];
  assert.ok(!holds(stripSecretRequestValues(deepText)));
});

test("a copy that does not parse as the result is dropped whole", () => {
  const cut = text.slice(0, text.length - 5);
  assert.equal(stripSecretRequestValues(cut), SECRET_REDACTED_TEXT);
  assert.equal(stripSecretRequestValues(`Result: ${text}`), SECRET_REDACTED_TEXT);
});

test("text that only mentions the words — this module's own source, prose — is left alone", () => {
  const source = [
    'const result = { secretRequest: record, value: VALUE, note: "x" };',
    "if (isSecretRequestResult(record) && SECRET_REQUEST_VALUE_KEY in record) { delete out.value; }",
    "The result carries `value` beside a `secretRequest` record.",
    'grep -n "secretRequest" src/*.ts | head  # value'
  ].join("\n");
  assert.equal(stripSecretRequestValues(source), source);
  assert.equal(stripSecretRequestValues({ output: source }).output, source);
  // …while a cut copy of a real result, escaped or not, is still dropped.
  const escaped = JSON.stringify(text).slice(0, -10);
  assert.equal(stripSecretRequestValues(`log: ${escaped}`), SECRET_REDACTED_TEXT);
});

test("nothing else changes, and an untouched value is the same reference", () => {
  const plain = { command: "ls", output: "a\nb", nested: [{ text: '{"other":1}' }] };
  assert.equal(stripSecretRequestValues(plain), plain);
  // An object that merely has a `value` key is not a result.
  const form = { name: "x", value: "kept" };
  assert.equal(stripSecretRequestValues(form), form);
  // JSON naming the marker but holding no value: unchanged text.
  const recorded = JSON.stringify({ secretRequest: record });
  assert.equal(stripSecretRequestValues(recorded), recorded);
  // The input is never mutated.
  const shape = { result: { structuredContent: { ...result } } };
  stripSecretRequestValues(shape);
  assert.equal(shape.result.structuredContent.value, VALUE);
});

test("the row keeps the request's record as its reference — name, purpose, outcome", () => {
  const data = stripSecretRequestValues({
    server: "orquester",
    tool: "request_secret",
    sessionTool: { name: "request_secret" },
    result: { content: [{ type: "text", text }], structuredContent: result }
  });
  assert.deepEqual(projectSessionToolData(data), { name: "request_secret", references: { secretRequest: record } });
  const slim = slimActivityPayload({ itemType: "mcp_tool_call", status: "completed", data }) as {
    data: { sessionTool?: unknown };
  };
  assert.ok(!holds(slim));
  assert.deepEqual(slim.data.sessionTool, { name: "request_secret", references: { secretRequest: record } });
  // Grok keeps the text the model read in ACP `content` wrappers, read before its `rawOutput`.
  const grok = stripSecretRequestValues({
    vendorTool: "orquester__request_secret",
    sessionTool: { name: "request_secret" },
    content: [{ type: "content", content: { type: "text", text } }],
    rawOutput: { type: "Mcp", ...result }
  });
  assert.deepEqual(projectSessionToolData(grok), { name: "request_secret", references: { secretRequest: record } });
  assert.deepEqual(secretRequestRecordOf(record), record);
  assert.equal(secretRequestRecordOf({ name: "x", outcome: "leaked" }), null);
});

test("a summary from untrusted JSON", () => {
  const summary = { requestId: "r1", sessionId: "s1", name: "K", prompt: "P", createdAt: "2026-10-14T00:00:00.000Z" };
  assert.deepEqual(parseSecretRequestSummary({ ...summary, purpose: "" }), summary);
  assert.deepEqual(parseSecretRequestSummary({ ...summary, purpose: "why" }), { ...summary, purpose: "why" });
  assert.equal(parseSecretRequestSummary({ ...summary, requestId: "" }), null);
  assert.equal(parseSecretRequestSummary(null), null);
  assert.equal(parseSecretRequestSummary({ ...summary, prompt: 5 }), null);
});
