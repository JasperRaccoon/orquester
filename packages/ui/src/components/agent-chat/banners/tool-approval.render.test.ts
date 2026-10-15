/**
 * Orquester approval cards (unified MCP §7.1, §9.3, §14.2.10), rendered, not mounted: every
 * section kind, `file` flags, "View all", no autofocus, sanitised plain text, the grant menu only
 * when offered, expiry, the toolset card, the phone's sheet, and the dock's order.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseToolApprovalSummary, type ParsedToolApprovalSummary } from "@orquester/api/agent-chat";

import { ChatBannerDock } from "./ChatBannerDock";
import { ToolApprovalCard } from "./ToolApprovalCard";

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const now = (): number => NOW;

function card(overrides: Record<string, unknown> = {}): ParsedToolApprovalSummary {
  const parsed = parseToolApprovalSummary({
    approvalId: "ap-1",
    threadId: "s1",
    tool: "edit_agent_profile",
    kind: "admin",
    family: "agent-profile",
    title: "Claude wants to add the skill `release-notes` to Claude Code",
    scope: { label: "Global — every Claude Code chat" },
    reason: "To draft release notes the way the team writes them.",
    sections: [
      { kind: "code", title: "SKILL.md", language: "markdown", text: "---\nname: release-notes\n---\nWrite notes.", sha256: "abc123" },
      { kind: "fields", title: "MCP server", rows: [
        { label: "command", value: "npx server" },
        { label: "API_TOKEN", value: "set", state: "set" },
        { label: "SECRET", value: "(asked)", state: "asked" },
        { label: "PLAIN", value: "sk-live-1234", state: "flagged" }
      ] },
      { kind: "diff", title: "CLAUDE.md", unifiedDiff: "@@ -1 +1 @@\n-old\n+new" },
      { kind: "changes", title: "Plugin provides", items: [{ label: "skill a", change: "added" }, { label: "hook b", change: "removed", detail: "run.sh" }] },
      { kind: "file", path: "bin/tool", size: 2048, sha256: "deadbeef", flag: "executable" },
      { kind: "file", path: "logo.png", size: 10, sha256: "cafe", flag: "binary" },
      { kind: "text", title: "Note", text: "plain words" },
      { kind: "warning", level: "danger", text: "This server points at this Orquester's /mcp." }
    ],
    fullPreview: false,
    secretFields: [],
    grantOptions: [],
    requestedAt: "2026-10-15T09:59:00.000Z",
    expiresAt: "2026-10-15T10:29:00.000Z",
    ...overrides
  });
  assert.ok(parsed);
  return parsed;
}

const render = (props: Partial<Parameters<typeof ToolApprovalCard>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ToolApprovalCard, {
      card: card(),
      pendingCount: 1,
      onAnswer: async () => undefined,
      onLoadFull: async () => null,
      now,
      ...props
    })
  );

test("every section kind renders as plain text, with the file flags in red", () => {
  const html = render();
  for (const kind of ["code", "fields", "diff", "changes", "file", "text", "warning"]) {
    assert.match(html, new RegExp(`data-preview-section="${kind}"`), kind);
  }
  assert.match(html, /data-file-flag="executable"/);
  assert.match(html, />Executable</);
  assert.match(html, /data-file-flag="binary"/);
  assert.match(html, /data-field-state="flagged"/);
  assert.match(html, /looks like a secret/);
  assert.match(html, /data-warning="danger"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /SKILL\.md/);
  assert.match(html, /Global — every Claude Code chat/);
  assert.match(html, /The agent&#x27;s reason/);
  // The "what will change" sentence is the client's own words, not the agent's.
  assert.match(html, /data-change-sentence="">Approving changes the agent CLI/);
  // Plain text: the backticks are text, never markup.
  assert.match(html, /`release-notes`/);
});

test("no card control is autofocused", () => {
  const html = render({ card: card({ secretFields: [{ key: "TOKEN", label: "API token" }], grantOptions: ["chat"], family: "desktops", kind: "admin" }) });
  assert.doesNotMatch(html, /autofocus/i);
});

test("agent text is sanitised: bidi overrides stripped from titles, escaped in code", () => {
  const html = render({
    card: card({
      title: "Add ‮evil‬ skill\nsecond line",
      reason: "why​ not",
      sections: [{ kind: "code", title: "run.sh", text: "rm -rf /‮txt.exe" }]
    })
  });
  assert.doesNotMatch(html, /[‪-‮⁦-⁩​]/);
  assert.match(html, /Add evil skill second line/);
  assert.match(html, /&lt;U\+202E&gt;/);
});

test("a long section is clamped behind View all; a cut summary offers to load the whole preview", () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const html = render({ card: card({ sections: [{ kind: "code", title: "hook.sh", text: long }] }) });
  assert.match(html, /data-view-all=""/);
  assert.match(html, /max-h-40/);
  assert.doesNotMatch(html, /data-load-full/);
  const cut = render({
    card: card({ fullPreview: true, sections: [{ kind: "text", text: "start…", partial: true }, { kind: "warning", level: "danger", text: "View all" }] })
  });
  assert.match(cut, /data-load-full=""/);
  assert.match(cut, /data-view-all=""/, "a partial section offers View all even when short");
});

test("the grant menu exists only when the daemon offered grants", () => {
  assert.doesNotMatch(render(), /data-grant-menu/);
  const offered = render({ card: card({ family: "desktops", grantOptions: ["chat", "project"] }) });
  assert.match(offered, /data-grant-menu=""/);
  assert.match(offered, />Approve once</);
});

test("secret fields are masked and approval waits for them", () => {
  const html = render({ card: card({ secretFields: [{ key: "TOKEN", label: "API token" }] }) });
  assert.match(html, /<input\b[^>]*type="password"/);
  assert.match(html, /<input\b[^>]*autocomplete="off"/i);
  assert.match(html, /<button\b[^>]*disabled=""[^>]*data-approve=""/);
});

test("the footer counts down to expiry; an expired card cannot be approved", () => {
  assert.match(render(), /Expires in 29 min/);
  const expired = render({ card: card({ expiresAt: "2026-10-15T09:59:59.000Z" }) });
  assert.match(expired, />Expired</);
  assert.match(expired, /<button\b[^>]*disabled=""[^>]*data-approve=""/);
});

test("a toolset card offers Enable for this chat / Deny", () => {
  const html = render({
    card: card({
      tool: "request_toolset",
      kind: "toolset",
      family: "toolset",
      title: "Claude asks to enable Workflow authoring for this chat",
      scope: { label: "This chat" },
      sections: [{ kind: "changes", title: "Tools", items: [{ label: "create_workflow · admin", change: "added" }] }]
    })
  });
  assert.match(html, />Enable for this chat</);
  assert.match(html, />Deny</);
  assert.match(html, /data-approval-kind="toolset"/);
  assert.match(html, /Enabling adds these tools to this chat only/);
});

test("a newer daemon's card can only be denied here", () => {
  const html = render({ card: card({ kind: "brand-new", family: "brand-new" }) });
  assert.match(html, /newer Orquester/);
  assert.match(html, /<button\b[^>]*disabled=""[^>]*data-approve=""/);
});

test("on a phone the preview goes behind a sheet; the flags stay on the card", () => {
  const html = render({ isMobile: true });
  assert.match(html, /Review what will run \(8 parts\)/);
  assert.match(html, /data-file-flag="executable"/);
  assert.match(html, /data-warning="danger"/);
  assert.doesNotMatch(html, /data-preview-section="code"/);
});

const dockProps = {
  sessionId: "s1",
  approvals: [],
  userInputs: [],
  respondingRequestIds: [],
  backgroundLiveness: null,
  liveAgentCount: 0,
  stopping: false,
  actionableProposedPlan: false,
  onApprove: () => undefined,
  onAnswer: () => undefined,
  onDismiss: () => undefined,
  onStopBackgroundWork: () => undefined,
  onCarryTextToDraft: () => undefined
};

test("the dock shows the oldest card with its counter, after a provider approval and before a question", () => {
  const first = card();
  const second = card({ approvalId: "ap-2", requestedAt: "2026-10-15T09:59:30.000Z" });
  const dock = renderToStaticMarkup(createElement(ChatBannerDock, { ...dockProps, toolApprovals: [first, second] }));
  assert.match(dock, /data-tool-approval="ap-1"/);
  assert.match(dock, />1\/2</);
  const question = {
    requestId: "q1",
    createdAt: "2026-10-15T09:00:00.000Z",
    dismissible: false,
    questions: [{ id: "a", header: "A", question: "Which?", options: [{ label: "x", description: "" }] }]
  };
  const withQuestion = renderToStaticMarkup(createElement(ChatBannerDock, { ...dockProps, userInputs: [question], toolApprovals: [first] }));
  assert.match(withQuestion, /data-tool-approval="ap-1"/);
  const providerApproval = { requestId: "p1", requestKind: "command" as const, createdAt: "2026-10-15T09:00:00.000Z", detail: "make" };
  const behind = renderToStaticMarkup(createElement(ChatBannerDock, { ...dockProps, approvals: [providerApproval], toolApprovals: [first] }));
  assert.doesNotMatch(behind, /data-tool-approval=/);
});
