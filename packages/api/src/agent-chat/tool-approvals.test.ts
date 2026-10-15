/**
 * Orquester approval cards (unified MCP design 2026-10-15 §7): the answer validator, secret
 * stripping, the text sanitiser, summary sizing, the tolerant summary read and the row reference.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sessionToolMarkedData } from "./session-tools.ts";
import { slimActivityPayload } from "./slim.ts";
import {
  ADMIN_APPROVAL_TIMEOUT_MS,
  approvalPreviewBytes,
  escapeApprovalCodeText,
  parseToolApprovalSummary,
  readToolApprovalReference,
  sanitizeApprovalLabel,
  sanitizeApprovalProse,
  stripToolApprovalSecrets,
  summarizeApprovalPreview,
  TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES,
  TOOL_APPROVAL_REFERENCE_KEY,
  TOOL_APPROVAL_SUMMARY_MAX_BYTES,
  toolApprovalReferenceOfActivityData,
  validateToolApprovalAnswer,
  type ApprovalPreviewSection,
  type ToolApprovalSummary
} from "./tool-approvals.ts";

const card = { grantOptions: ["chat" as const], secretFields: [{ key: "env.API_KEY", label: "API_KEY" }] };

test("limits are the spec's", () => {
  assert.equal(ADMIN_APPROVAL_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(TOOL_APPROVAL_SUMMARY_MAX_BYTES, 64 * 1024);
  assert.equal(TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES, 1024 * 1024);
});

test("the answer validator: approve with every secret, optionally a grant it offers", () => {
  assert.deepEqual(validateToolApprovalAnswer({ decision: "approve", secrets: { "env.API_KEY": "s3cret" } }, card), {
    ok: true,
    answer: { decision: "approve", secrets: { "env.API_KEY": "s3cret" } }
  });
  assert.deepEqual(validateToolApprovalAnswer({ decision: "approve", grant: "chat", secrets: { "env.API_KEY": "v" } }, card), {
    ok: true,
    answer: { decision: "approve", grant: "chat", secrets: { "env.API_KEY": "v" } }
  });
  assert.deepEqual(validateToolApprovalAnswer({ decision: "approve" }, { grantOptions: [], secretFields: [] }), {
    ok: true,
    answer: { decision: "approve" }
  });
});

test("the answer validator refuses what the card did not offer, and never quotes a value", () => {
  const refusals: unknown[] = [
    null,
    [],
    { decision: "maybe" },
    { decision: "approve", grant: "project", secrets: { "env.API_KEY": "v" } },
    { decision: "approve", grant: "forever", secrets: { "env.API_KEY": "v" } },
    { decision: "approve" },
    { decision: "approve", secrets: { "env.API_KEY": "" } },
    { decision: "approve", secrets: { "env.API_KEY": "v", "env.OTHER": "leak-me" } },
    { decision: "approve", secrets: { "env.API_KEY": "x".repeat(8 * 1024 + 1) } },
    { decision: "approve", secrets: "nope" },
    { decision: "deny", grant: "chat" },
    { decision: "deny", reason: 5 },
    { decision: "approve", secrets: { "env.API_KEY": "v" }, extra: true }
  ];
  for (const body of refusals) {
    const result = validateToolApprovalAnswer(body, card);
    assert.equal(result.ok, false, JSON.stringify(body)?.slice(0, 80));
    if (!result.ok) assert.doesNotMatch(result.message, /leak-me/);
  }
});

test("a deny keeps a sanitised, capped reason and drops any secrets sent", () => {
  const result = validateToolApprovalAnswer(
    { decision: "deny", reason: `  not now‮\r\nplease ${"x".repeat(600)}`, secrets: { "env.API_KEY": "v" } },
    card
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.answer.decision, "deny");
  assert.equal(result.answer.secrets, undefined);
  assert.ok(result.answer.reason!.startsWith("not now\nplease "));
  assert.ok(result.answer.reason!.length <= 500);
  assert.doesNotMatch(result.answer.reason!, /‮/);
});

test("secret stripping removes `secrets` keys by shape and masks known values everywhere", () => {
  const value = {
    answer: { decision: "approve", secrets: { k: "hunter2-value" } },
    log: ["wrote hunter2-value to config", { nested: JSON.stringify({ env: "hunter2-value" }) }],
    short: "ab"
  };
  const stripped = stripToolApprovalSecrets(value, ["hunter2-value", "ab"]);
  assert.deepEqual(stripped, {
    answer: { decision: "approve" },
    log: ["wrote [secret redacted] to config", { nested: JSON.stringify({ env: "[secret redacted]" }) }],
    short: "ab"
  });
  const clean = { a: 1, b: ["x"] };
  assert.equal(stripToolApprovalSecrets(clean, ["zzzz"]), clean, "nothing to strip: same reference");
});

test("labels are one line without bidi, control or zero-width characters", () => {
  assert.equal(sanitizeApprovalLabel("Add‮skill⁦ `x`\n\tnow​\u0007"), "Addskill `x` now");
  assert.equal(sanitizeApprovalLabel("a b"), "a b");
  const long = sanitizeApprovalLabel("😀".repeat(400), 11);
  assert.ok(long.length <= 11 && long.endsWith("…"));
  assert.doesNotMatch(long.slice(0, -1), /[\ud800-\udbff]$/, "never a lone high surrogate");
});

test("prose keeps lines and tabs; code shows hidden characters as visible escapes", () => {
  assert.equal(sanitizeApprovalProse("a\r\nb‮\tc\u0000"), "a\nb\tc");
  assert.equal(escapeApprovalCodeText("rm -rf /‮#\r\nok​"), "rm -rf /<U+202E>#\nok<U+200B>");
});

test("a summary carries the whole preview when it fits, and cuts long text — never a flag — when it does not", () => {
  const small: ApprovalPreviewSection[] = [{ kind: "text", text: "hi" }];
  assert.deepEqual(summarizeApprovalPreview(small), { sections: small, fullPreview: false });

  const big: ApprovalPreviewSection[] = [
    { kind: "warning", level: "danger", text: "Points at this daemon's /mcp" },
    { kind: "code", title: "SKILL.md", text: "é".repeat(200_000) },
    { kind: "diff", title: "CLAUDE.md", unifiedDiff: "+".repeat(200_000) },
    { kind: "file", path: "bin/tool", size: 10, sha256: "ab", flag: "executable" }
  ];
  const summary = summarizeApprovalPreview(big);
  assert.equal(summary.fullPreview, true);
  assert.ok(approvalPreviewBytes(summary.sections) <= TOOL_APPROVAL_SUMMARY_MAX_BYTES, String(approvalPreviewBytes(summary.sections)));
  assert.deepEqual(summary.sections[0], big[0]);
  assert.deepEqual(summary.sections.at(-1), big[3]);
  const code = summary.sections.find((s) => s.kind === "code");
  assert.ok(code && code.kind === "code" && code.partial === true && code.text.length > 0);
  assert.ok(!code.text.includes("�"), "cut on a character boundary");
});

const SUMMARY: ToolApprovalSummary = {
  approvalId: "ap-1",
  threadId: "t-1",
  tool: "edit_agent_profile",
  kind: "admin",
  family: "agent-profile",
  title: "Claude wants to add the skill `release-notes` to Claude Code",
  scope: { label: "Global — every Claude Code chat" },
  reason: "The user asked for it.",
  sections: [
    { kind: "code", title: "SKILL.md", language: "markdown", text: "# Notes" },
    { kind: "fields", rows: [{ label: "API_KEY", value: "asked", state: "asked" }] },
    { kind: "changes", title: "Items", items: [{ label: "release-notes", change: "added" }] },
    { kind: "warning", level: "caution", text: "Looks like a secret." }
  ],
  fullPreview: false,
  secretFields: [{ key: "env.API_KEY", label: "API_KEY" }],
  grantOptions: [],
  requestedAt: "2026-10-15T10:00:00.000Z",
  expiresAt: "2026-10-15T10:30:00.000Z"
};

test("a summary read from untrusted JSON round-trips, sanitised; unknown sections become a caution", () => {
  assert.deepEqual(parseToolApprovalSummary(JSON.parse(JSON.stringify(SUMMARY))), SUMMARY);
  const odd = parseToolApprovalSummary({
    ...SUMMARY,
    title: "Ok‮evil",
    grantOptions: ["chat", "forever", "chat"],
    sections: [{ kind: "hologram" }, { kind: "code", title: "x", text: "a‮b" }]
  });
  assert.ok(odd);
  assert.equal(odd.title, "Okevil");
  assert.deepEqual(odd.grantOptions, ["chat"]);
  assert.equal(odd.sections[0]?.kind, "warning");
  assert.deepEqual(odd.sections[1], { kind: "code", title: "x", text: "a<U+202E>b" });
  for (const bad of [null, { ...SUMMARY, family: "root" }, { ...SUMMARY, kind: "x" }, { ...SUMMARY, scope: null }, { ...SUMMARY, approvalId: "" }]) {
    assert.equal(parseToolApprovalSummary(bad), null);
  }
});

test("the row keeps its toolApproval reference through slimming, and a malformed one is none", () => {
  const ref = { approvalId: "ap-1", kind: "admin", family: "workflows", title: "Run workflow Deploy", outcome: "approved", grantId: "g_1" };
  const data = sessionToolMarkedData(
    { toolName: "mcp__orquester__run_workflow", input: {}, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, [TOOL_APPROVAL_REFERENCE_KEY]: ref, out: "x".repeat(20_000) }) }] } },
    new Set(["run_workflow"])
  );
  const slim = slimActivityPayload({ itemType: "mcp_tool_call", status: "completed", data }) as { data: unknown };
  assert.deepEqual(toolApprovalReferenceOfActivityData(slim.data), ref);
  assert.deepEqual(readToolApprovalReference({ kind: "admin", family: "desktops", title: "Open", outcome: "granted", grantId: "g" }), {
    kind: "admin",
    family: "desktops",
    title: "Open",
    outcome: "granted",
    grantId: "g"
  });
  assert.equal(readToolApprovalReference({ kind: "admin", family: "desktops", title: "x", outcome: "approved" }), undefined, "a card outcome needs its id");
  assert.equal(readToolApprovalReference({ ...ref, family: "root" }), undefined);
  assert.equal(readToolApprovalReference({ ...ref, outcome: "maybe" }), undefined);
});
