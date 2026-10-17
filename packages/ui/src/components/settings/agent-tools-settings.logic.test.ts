/**
 * Settings › Agent tools (unified MCP §7.6): grant wording, and the rendered page — every tool is
 * available, no toolset switch or matrix, the grants with Revoke and Revoke all.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { agentToolsStore, resetAgentTools } from "../../lib/agent-tools/store";
import { AgentToolsSettings } from "./AgentToolsSettings";
import { describeGrant } from "./agent-tools-settings.logic";

test("grants read as what, where and how far", () => {
  const titleOf = (id: string) => (id === "t1" ? "Plan the API" : null);
  const chat = { id: "g1", family: "workflows", scope: "chat", projectPath: "/w/acme/web", threadId: "t1", workflowIds: ["a", "b"], createdAt: "c" };
  assert.deepEqual(describeGrant(chat, titleOf), { id: "g1", what: "Workflow changes", where: "Chat “Plan the API”", detail: "2 workflows", scope: "chat" });
  assert.equal(describeGrant(chat, titleOf, "t1").where, "This chat");
  assert.equal(describeGrant({ ...chat, threadId: "gone" }, titleOf).where, "A chat");
  const project = { id: "g2", family: "desktops", scope: "project", projectPath: "/w/acme/web", createdAt: "c" };
  assert.equal(describeGrant(project, titleOf).where, "Project acme/web");
  const cross = { id: "g3", family: "cross-project", scope: "chat", projectPath: "/w/a/b", threadId: "t1", targetProjectPath: "/w/other/api", createdAt: "c" };
  assert.equal(describeGrant(cross, titleOf).detail, "in other/api");
  assert.equal(describeGrant({ ...project, family: "future-thing" }, titleOf).what, "future-thing");
});

test("the page says every tool is available and lists the grants; no switch, no matrix", () => {
  resetAgentTools();
  agentToolsStore.setState({
    settings: {
      grants: [{ id: "g1", family: "desktops", scope: "project", projectPath: "/w/acme/web", createdAt: "2026-10-15T09:00:00.000Z" }]
    }
  });
  const html = renderToStaticMarkup(createElement(AgentToolsSettings));
  assert.match(html, /Every Orquester tool is available in every agent chat/);
  assert.match(html, /Admin tools ask for your approval/);
  assert.doesNotMatch(html, /role="switch"/);
  assert.doesNotMatch(html, /data-agent-tools-matrix|Extra toolsets|Toolsets per agent|Reset to defaults/);
  assert.match(html, /data-grant-id="g1"/);
  assert.match(html, /Project acme\/web/);
  assert.match(html, />Revoke all</);
  resetAgentTools();
});

test("no grants: an empty state, and no Revoke all", () => {
  resetAgentTools();
  agentToolsStore.setState({ settings: { grants: [] } });
  const html = renderToStaticMarkup(createElement(AgentToolsSettings));
  assert.match(html, /No grants/);
  assert.doesNotMatch(html, />Revoke all</);
  resetAgentTools();
});

test("an older daemon without the routes says so", () => {
  resetAgentTools();
  agentToolsStore.setState({ settingsUnsupported: true });
  assert.match(renderToStaticMarkup(createElement(AgentToolsSettings)), /predates agent tool grants/);
  resetAgentTools();
});
