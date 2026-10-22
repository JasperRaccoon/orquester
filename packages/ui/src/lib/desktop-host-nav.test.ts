/**
 * A clicked desktop notification opens its session's project and tab, or its
 * workflow run through the deep link; a session the store has not loaded yet
 * is handed back for a retry.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "@orquester/api";

import { useAppStore } from "../store/app.ts";
import { openNotificationTarget, openSessionById, viewingSessionId } from "./desktop-host-nav.ts";
import { takeWorkflowDeepLink } from "./workflows/deep-link.ts";

const session = (id: string, projectPath: string) => ({ id, projectPath }) as SessionSummary;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  takeWorkflowDeepLink();
  useAppStore.setState({
    currentWorkspace: "acme",
    currentProject: { path: "/w/acme/app", name: "app", workspace: "acme", isArchived: false } as ProjectSummary,
    activeTabByProject: { "/w/acme/app": "c1" },
    workspaces: [
      { name: "acme", path: "/w/acme" },
      { name: "beta", path: "/w/beta" }
    ] as WorkspaceSummary[],
    projects: [],
    sessions: [session("c1", "/w/acme/app"), session("c2", "/w/beta/api"), session("s1", "")],
    openWorkspace: async (name: string) => {
      calls.push(`workspace:${name}`);
    },
    openProject: (project: ProjectSummary) => {
      calls.push(`project:${project.path}`);
    },
    activateTab: (id: string) => {
      calls.push(`tab:${id}`);
    }
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

  it("opens a session in another workspace: workspace, project, then the tab", () => {
    assert.equal(openSessionById("c2"), true);
    assert.deepEqual(calls, ["workspace:beta", "project:/w/beta/api", "tab:c2"]);
  });

  it("hands back a session the store does not know, and opens none without a project", () => {
    assert.equal(openNotificationTarget({ kind: "session", sessionId: "later" }), "later");
    assert.equal(openSessionById("s1"), false);
    assert.deepEqual(calls, []);
    useAppStore.setState({ sessions: [...useAppStore.getState().sessions, session("later", "/w/acme/app")] });
    assert.equal(openNotificationTarget({ kind: "session", sessionId: "later" }), null);
    assert.deepEqual(calls, ["project:/w/acme/app", "tab:later"]);
  });

  it("opens a workflow run through the deep link", () => {
    assert.equal(openNotificationTarget({ kind: "workflow", workflowId: "w1", runId: "r1" }), null);
    assert.deepEqual(takeWorkflowDeepLink(), { workflowId: "w1", runId: "r1" });
  });
});
