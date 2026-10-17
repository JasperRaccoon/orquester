/**
 * The chat's Tools chip (unified MCP §7.6): every tool is on, so it counts the chat's grants, says
 * why a workflow-owned chat has no Admin tools, and offers no toolset switch.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentToolGrant, ThreadAgentToolsResponse } from "@orquester/api";

import { deriveToolsChip } from "./tools-chip";
import { ToolsChipView } from "./ToolsChip";

const grant = (id: string): AgentToolGrant => ({ id, family: "desktops", scope: "chat", threadId: "t1", projectPath: "/w/acme/api", createdAt: "2026-10-15T10:00:00.000Z" });

const data = (extra: Partial<ThreadAgentToolsResponse> = {}): ThreadAgentToolsResponse => ({
  threadId: "t1",
  agent: "claude",
  workflowOwned: false,
  grants: [],
  ...extra
});

test("no grants: a plain Tools chip saying every tool is available", () => {
  const model = deriveToolsChip(data());
  assert.equal(model.label, "Tools");
  assert.equal(model.grantCount, 0);
  assert.match(model.title, /Every Orquester tool is available in this chat · no grants/);
  assert.equal(model.note, null);
});

test("grants are counted; a workflow-owned chat says it has no Admin tools", () => {
  const model = deriveToolsChip(data({ grants: [grant("a"), grant("b")], workflowOwned: true }));
  assert.equal(model.label, "Tools · 2");
  assert.match(model.ariaLabel, /2 grants/);
  assert.match(model.note ?? "", /no Admin tools/);
  assert.equal(deriveToolsChip(data({ grants: [grant("a")] })).label, "Tools · 1");
});

test("the chip renders its label and never its panel until clicked; no toolset switch anywhere", () => {
  const html = renderToStaticMarkup(createElement(ToolsChipView, { sessionId: "t1", data: data({ grants: [grant("a")] }) }));
  assert.match(html, /data-tools-chip="t1"/);
  assert.match(html, /Tools · 1/);
  assert.doesNotMatch(html, /data-tools-panel/);
  assert.doesNotMatch(html, /data-toolset|Default \(|toolset/i);
  assert.doesNotMatch(html, /autofocus/i);
});
