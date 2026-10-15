/**
 * Whiteboard tabs (the Excalidraw plugin) on the actual app store: one tab per
 * file per project, closing like any client-local tab, and a new whiteboard
 * created through the upload route before its tab opens.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { FsUploadRequest, FsUploadResponse, ProjectSummary } from "@orquester/api";

import type { ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const P = "/w/acme/app";
const project = { name: "app", workspace: "acme", path: P } as ProjectSummary;
const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    api: null,
    currentProject: project,
    whiteboardTabsByProject: {},
    activeTabByProject: {},
    sessions: [],
    browsers: [],
    desktops: [],
    notice: null
  });
});

describe("openWhiteboard", () => {
  it("opens a tab per file, titled by the file name, and focuses an open one again", () => {
    store().openWhiteboard(`${P}/whiteboards/Plan.excalidraw`);
    const [tab] = store().whiteboardTabsByProject[P] ?? [];
    assert.equal(tab?.title, "Plan");
    assert.equal(tab?.path, `${P}/whiteboards/Plan.excalidraw`);
    assert.equal(store().activeTabByProject[P], tab?.id);

    store().openWhiteboard(`${P}/docs/flow.excalidraw`);
    assert.equal(store().whiteboardTabsByProject[P]?.length, 2);
    store().openWhiteboard(`${P}/whiteboards/Plan.excalidraw`);
    assert.equal(store().whiteboardTabsByProject[P]?.length, 2);
    assert.equal(store().activeTabByProject[P], tab?.id);
  });

  it("closing the active whiteboard tab activates another tab of the project", async () => {
    store().openWhiteboard(`${P}/a.excalidraw`);
    store().openWhiteboard(`${P}/b.excalidraw`);
    const [first, second] = store().whiteboardTabsByProject[P] ?? [];
    await store().closeTab(second!.id);
    assert.deepEqual(
      store().whiteboardTabsByProject[P]?.map((t) => t.id),
      [first!.id]
    );
    assert.equal(store().activeTabByProject[P], first!.id);
  });

  it("does nothing outside a project", () => {
    useAppStore.setState({ currentProject: null });
    store().openWhiteboard(`${P}/a.excalidraw`);
    assert.deepEqual(store().whiteboardTabsByProject, {});
  });
});

describe("createWhiteboard", () => {
  function api(answers: FsUploadResponse[]) {
    const calls: FsUploadRequest[] = [];
    const client = {
      uploadFsEntry: async (meta: FsUploadRequest) => {
        calls.push(meta);
        const answer = answers.shift();
        if (!answer) throw new Error("no answer");
        return answer;
      }
    };
    useAppStore.setState({ api: client as unknown as ApiClient });
    return calls;
  }

  it("writes an empty scene to whiteboards/Untitled.excalidraw and opens it", async () => {
    const path = `${P}/whiteboards/Untitled.excalidraw`;
    const calls = api([{ path, name: "Untitled.excalidraw", size: 10 }]);
    await store().createWhiteboard();
    assert.deepEqual(calls, [
      { destDir: `${P}/whiteboards`, relativePath: "Untitled.excalidraw", onConflict: "error" }
    ]);
    assert.equal(store().whiteboardTabsByProject[P]?.[0]?.path, path);
  });

  it("takes a numbered name when Untitled is taken", async () => {
    const path = `${P}/whiteboards/Untitled (1).excalidraw`;
    const calls = api([
      { path: "", name: "Untitled.excalidraw", size: 0, conflict: true, conflictKind: "file" },
      { path, name: "Untitled (1).excalidraw", size: 10 }
    ]);
    await store().createWhiteboard();
    assert.deepEqual(
      calls.map((c) => c.onConflict),
      ["error", "rename"]
    );
    assert.equal(store().whiteboardTabsByProject[P]?.[0]?.title, "Untitled (1)");
  });

  it("raises a notice and opens nothing when the file cannot be written", async () => {
    // A file named "whiteboards" blocks the folder: both attempts conflict.
    const blocked: FsUploadResponse = { path: "", name: "Untitled.excalidraw", size: 0, conflict: true, conflictKind: "file" };
    api([blocked, { ...blocked }]);
    await store().createWhiteboard();
    assert.deepEqual(store().whiteboardTabsByProject, {});
    assert.equal(store().notice?.message, 'Could not create a whiteboard: a file named "whiteboards" is in the way.');

    api([]);
    await store().createWhiteboard();
    assert.equal(store().notice?.message, "Could not create a whiteboard: no answer");
  });
});
