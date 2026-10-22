/**
 * A clicked desktop notification opens its session or its workflow run
 * through the matching deep link (`SessionDeepLinkHost` resolves the session
 * against the daemon once connected).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ProjectSummary } from "@orquester/api";

import { useAppStore } from "../store/app.ts";
import { openNotificationTarget, viewingSessionId } from "./desktop-host-nav.ts";
import { takeSessionDeepLink } from "./session-deep-link.ts";
import { takeWorkflowDeepLink } from "./workflows/deep-link.ts";

beforeEach(() => {
  takeWorkflowDeepLink();
  takeSessionDeepLink();
  useAppStore.setState({
    currentWorkspace: "acme",
    currentProject: { path: "/w/acme/app", name: "app", workspace: "acme", isArchived: false } as ProjectSummary,
    activeTabByProject: { "/w/acme/app": "c1" }
  });
});

describe("desktop notification navigation", () => {
  it("knows the tab on screen", () => {
    assert.equal(viewingSessionId(), "c1");
    useAppStore.setState({ currentProject: null, activeTabByProject: { acme: "s1" } });
    assert.equal(viewingSessionId(), "s1");
    useAppStore.setState({ currentWorkspace: null });
    assert.equal(viewingSessionId(), null);
  });

  it("opens a session through the session deep link", () => {
    openNotificationTarget({ kind: "session", sessionId: "c2" });
    assert.deepEqual(takeSessionDeepLink(), { sessionId: "c2" });
    assert.equal(takeWorkflowDeepLink(), null);
  });

  it("opens a workflow run through the workflow deep link", () => {
    openNotificationTarget({ kind: "workflow", workflowId: "w1", runId: "r1" });
    assert.deepEqual(takeWorkflowDeepLink(), { workflowId: "w1", runId: "r1" });
    assert.equal(takeSessionDeepLink(), null);
  });
});
