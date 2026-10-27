import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ApiClient } from "./api-client.ts";
import {
  parseSessionDeepLink,
  parseSessionOpenMessage,
  pendingSessionDeepLink,
  requestSessionDeepLink,
  resolveSessionDeepLink,
  stripSessionDeepLink,
  subscribeSessionDeepLink,
  takeSessionDeepLink
} from "./session-deep-link.ts";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "../types/index.ts";

const ID = "3f2c1a9e-8b7d-4c6e-9f00-112233445566";

describe("session deep links", () => {
  it("parses ?session=", () => {
    assert.deepEqual(parseSessionDeepLink(`?session=${ID}`), { sessionId: ID });
    assert.deepEqual(parseSessionDeepLink("session=s-1&x=2"), { sessionId: "s-1" });
    assert.equal(parseSessionDeepLink("?session=../etc"), null);
    assert.equal(parseSessionDeepLink("?session=%3Cscript%3E"), null);
    assert.equal(parseSessionDeepLink("?session="), null);
    assert.equal(parseSessionDeepLink("?workflow=wf-1"), null);
    assert.equal(parseSessionDeepLink(""), null);
  });

  it("strips its parameter and keeps the rest", () => {
    assert.equal(stripSessionDeepLink(`https://o.example.com/?session=${ID}`), "/");
    assert.equal(stripSessionDeepLink("https://o.example.com/app?x=1&session=s#h"), "/app?x=1#h");
    assert.equal(stripSessionDeepLink("not a url"), "not a url");
  });

  it("parses the service worker's message; anything else is null", () => {
    assert.deepEqual(parseSessionOpenMessage({ type: "orquester:open-session", sessionId: ID }), { sessionId: ID });
    assert.equal(parseSessionOpenMessage({ type: "orquester:open-workflow-run", sessionId: ID }), null);
    assert.equal(parseSessionOpenMessage({ type: "orquester:open-session", sessionId: "a b" }), null);
    assert.equal(parseSessionOpenMessage({ type: "orquester:open-session" }), null);
    assert.equal(parseSessionOpenMessage("orquester:open-session"), null);
    assert.equal(parseSessionOpenMessage(null), null);
  });

  it("one pending link, taken once, listeners told", () => {
    let told = 0;
    const off = subscribeSessionDeepLink(() => {
      told += 1;
    });
    requestSessionDeepLink({ sessionId: "a" });
    requestSessionDeepLink({ sessionId: "b" });
    assert.equal(told, 2);
    assert.deepEqual(pendingSessionDeepLink(), { sessionId: "b" });
    assert.deepEqual(takeSessionDeepLink(), { sessionId: "b" });
    assert.equal(takeSessionDeepLink(), null);
    assert.equal(told, 3);
    off();
  });
});

describe("where a session's link leads", () => {
  const workspace = { name: "main", path: "/w/main", isArchived: false } as WorkspaceSummary;
  const archivedWorkspace = { name: "old", path: "/w/old", isArchived: true } as WorkspaceSummary;
  const project = { name: "app", workspace: "main", path: "/w/main/app", isArchived: false } as ProjectSummary;
  const archivedProject = { name: "gone", workspace: "main", path: "/w/main/gone", isArchived: true } as ProjectSummary;
  const archivedWorkspaceProject = { ...project, name: "thing", workspace: "old", path: "/w/old/thing" };

  function fakeApi(options: { sessions: Array<Partial<SessionSummary>>; failProjects?: boolean }) {
    const asked: string[] = [];
    const api = {
      listSessions: async () => options.sessions as SessionSummary[],
      listWorkspaces: async () => [workspace, archivedWorkspace],
      listProjects: async (name: string) => {
        asked.push(name);
        if (options.failProjects) throw new Error("offline");
        return name === "main" ? [project, archivedProject] : [archivedWorkspaceProject];
      }
    } as unknown as Pick<ApiClient, "listSessions" | "listWorkspaces" | "listProjects">;
    return { api, asked };
  }

  it("opens the session in its own project", async () => {
    const { api, asked } = fakeApi({ sessions: [{ id: ID, projectPath: "/w/main/app" }] });
    assert.deepEqual(await resolveSessionDeepLink(api, ID), { kind: "open", sessionId: ID, project });
    assert.deepEqual(asked, ["main"], "archived workspaces are not listed");
  });

  it("says so when the session is gone", async () => {
    const { api } = fakeApi({ sessions: [{ id: "other", projectPath: "/w/main/app" }] });
    assert.deepEqual(await resolveSessionDeepLink(api, ID), { kind: "gone", message: "That session no longer exists." });
  });

  it("does not open a session behind the archived curtain", async () => {
    for (const projectPath of ["/w/main/gone", "/w/old/thing", "/elsewhere/x"]) {
      const { api } = fakeApi({ sessions: [{ id: ID, projectPath }] });
      const target = await resolveSessionDeepLink(api, ID);
      assert.equal(target.kind, "gone", projectPath);
    }
  });

  it("a session without a project, or a project list that failed, is not opened", async () => {
    const bare = fakeApi({ sessions: [{ id: ID, projectPath: "" }] });
    assert.equal((await resolveSessionDeepLink(bare.api, ID)).kind, "gone");
    const failing = fakeApi({ sessions: [{ id: ID, projectPath: "/w/main/app" }], failProjects: true });
    assert.deepEqual(await resolveSessionDeepLink(failing.api, ID), {
      kind: "gone",
      message: "Couldn't open that session: its project could not be listed."
    });
  });

  it("a failed session list throws (the host retries after a reconnect)", async () => {
    const offline = new Error("offline");
    const api = {
      listSessions: async () => {
        throw offline;
      }
    } as unknown as Pick<ApiClient, "listSessions" | "listWorkspaces" | "listProjects">;
    await assert.rejects(resolveSessionDeepLink(api, ID), (error) => error === offline);
  });
});
