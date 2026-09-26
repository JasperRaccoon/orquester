/**
 * Render checks for the chat's crash fallbacks (§7.1, §7.6).
 *
 * The server renderer runs no error boundary — a throw in a static render
 * propagates — so the fallback is rendered off an instance whose state holds
 * the error: what the user is left with once a child row has thrown. It is a
 * claim about markup: a way back that is a real, touch-sized button, inside
 * the drill-in's own boundary, which `AgentChatView` puts around the drill-in
 * alone so the composer and the roster stay mounted over it.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { DrillInErrorBoundary } from "./roster/DrillInErrorBoundary";

const drillIn = new DrillInErrorBoundary({ agentId: "agent-1", onBack: () => {}, children: null });
drillIn.state = { error: new Error("a malformed row") };
const fallback = renderToStaticMarkup(drillIn.render() as ReactElement);
assert.ok(fallback.includes('data-drill-in-crashed="agent-1"'), fallback);
assert.ok(fallback.includes("Back to the thread"), "the way back is on screen, on any device");
assert.match(fallback, /<button type="button" class="[^"]*min-h-10[^"]*"/, "a touch-sized button, not a key");
assert.ok(fallback.includes("a malformed row"), "and it says what broke");
assert.ok(fallback.includes("the thread are untouched"));

const thread = new ChatErrorBoundary({ sessionId: "s1", children: null });
thread.state = { error: new Error("boom") };
assert.ok(renderToStaticMarkup(thread.render() as ReactElement).includes("Try again"));

console.log("agent-chat error boundary render checks passed");
