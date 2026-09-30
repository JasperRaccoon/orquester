/**
 * Desktop tabs in the app store (spec §10.1, §10.6): the `desktop` channel's
 * events, the launch actions and the close flow, run on the actual store with
 * a stub API client.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { DESKTOP_CHANNEL, type DesktopAppSummary, type DesktopSummary } from "@orquester/api";

import { ApiError, type ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const P = "/w/acme/app";

function desktop(overrides: Partial<DesktopSummary> & { id: string }): DesktopSummary {
  return {
    projectPath: P,
    title: `Desktop ${overrides.id}`,
    order: 0,
    createdAt: "2026-09-30T10:00:00.000Z",
    display: 10,
    size: { width: 1280, height: 800 },
    renderThreads: 4,
    status: "running",
    audio: "available",
    apps: [],
    windows: [],
    activeWindowId: null,
    ...overrides
  };
}

function app(id: string, status: DesktopAppSummary["status"]): DesktopAppSummary {
  return {
    id,
    desktopId: "d1",
    command: "xterm",
    cwd: P,
    env: {},
    status,
    exitCode: null,
    startedAt: "2026-09-30T10:00:00.000Z",
    exitedAt: null
  };
}

const event = (type: string, payload: unknown) => ({
  id: `${DESKTOP_CHANNEL}:${type}`,
  channel: DESKTOP_CHANNEL,
  type,
  createdAt: "2026-09-30T10:00:00.000Z",
  payload
});

const store = () => useAppStore.getState();

/** A stub client recording the desktop calls the store makes. */
function stubApi(overrides: Partial<Record<string, (...args: never[]) => unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const api = {
    closeDesktop: async (id: string) => {
      calls.push(["closeDesktop", id]);
    },
    createDesktop: async (body: unknown) => {
      calls.push(["createDesktop", body]);
      return desktop({ id: "new", title: "New" });
    },
    launchDesktopApp: async (id: string, body: unknown) => {
      calls.push(["launchDesktopApp", id, body]);
      return app("a9", "starting");
    },
    ...overrides
  };
  useAppStore.setState({ api: api as unknown as ApiClient });
  return calls;
}

beforeEach(() => {
  useAppStore.setState({
    api: null,
    sessions: [],
    browsers: [],
    desktops: [],
    fileTabsByProject: {},
    gitTabsByProject: {},
    todoTabsByContext: {},
    workflowTabsByProject: {},
    activeTabByProject: {},
    pendingCloseTabId: null,
    launchDialog: null,
    notice: null
  });
});

describe("desktop channel events", () => {
  it("created and updated upsert; closed removes and moves the active tab on", () => {
    store().applyEvent(event("desktop.created", desktop({ id: "d1" })));
    store().applyEvent(event("desktop.created", desktop({ id: "d2", order: 1 })));
    store().applyEvent(event("desktop.updated", desktop({ id: "d1", title: "Main", status: "stopped" })));
    assert.deepEqual(store().desktops.map((d) => [d.id, d.title, d.status]), [
      ["d1", "Main", "stopped"],
      ["d2", "Desktop d2", "running"]
    ]);

    useAppStore.setState({ activeTabByProject: { [P]: "d1" } });
    store().applyEvent(event("desktop.closed", { id: "d1" }));
    assert.deepEqual(store().desktops.map((d) => d.id), ["d2"]);
    assert.equal(store().activeTabByProject[P], "d2");
  });

  it("malformed payloads never reach state", () => {
    store().applyEvent(event("desktop.created", { id: "d1" }));
    store().applyEvent(event("desktop.updated", "nope"));
    store().applyEvent(event("desktop.closed", { id: 5 }));
    store().applyEvent(event("desktop.windows", { desktopId: "d1", windows: "x" }));
    assert.deepEqual(store().desktops, []);
  });

  it("desktop.windows patches that desktop's windows and active window", () => {
    useAppStore.setState({ desktops: [desktop({ id: "d1" }), desktop({ id: "d2" })] });
    const other = store().desktops[1];
    store().applyEvent(
      event("desktop.windows", {
        desktopId: "d1",
        windows: [{ id: "0x1", title: "xterm", appId: "a1", wmClass: "XTerm", maximized: true }],
        activeWindowId: "0x1"
      })
    );
    const [d1, d2] = store().desktops;
    assert.equal(d1?.windows[0]?.title, "xterm");
    assert.equal(d1?.activeWindowId, "0x1");
    assert.equal(d2, other, "the other desktop is untouched");
  });

  it("closing a desktop dismisses its pending confirm and retargets an open launch dialog", () => {
    useAppStore.setState({
      desktops: [desktop({ id: "d1" })],
      pendingCloseTabId: "d1",
      launchDialog: { projectPath: P, targetDesktopId: "d1" }
    });
    store().applyEvent(event("desktop.closed", { id: "d1" }));
    assert.equal(store().pendingCloseTabId, null);
    assert.deepEqual(store().launchDialog, { projectPath: P, targetDesktopId: null });
  });
});

describe("launching", () => {
  it("createDesktopWithApp posts, adds the desktop and activates its tab", async () => {
    const calls = stubApi();
    const created = await store().createDesktopWithApp({ projectPath: P, app: { command: "xterm" } });
    assert.equal(created.id, "new");
    assert.deepEqual(calls, [["createDesktop", { projectPath: P, app: { command: "xterm" } }]]);
    assert.deepEqual(store().desktops.map((d) => d.id), ["new"]);
    assert.equal(store().activeTabByProject[P], "new");
  });

  it("launchIntoDesktop posts the app, records it and focuses that desktop", async () => {
    useAppStore.setState({ desktops: [desktop({ id: "d1" })], activeTabByProject: { [P]: "elsewhere" } });
    const calls = stubApi();
    await store().launchIntoDesktop("d1", { command: "xterm", cwd: "tools" });
    assert.deepEqual(calls, [["launchDesktopApp", "d1", { command: "xterm", cwd: "tools" }]]);
    assert.deepEqual(store().desktops[0]?.apps.map((a) => a.id), ["a9"]);
    assert.equal(store().activeTabByProject[P], "d1");
  });

  it("a daemon refusal rejects so the dialog can show it", async () => {
    stubApi({
      createDesktop: async () => {
        throw new ApiError(409, "POST", "/api/desktops", undefined, { code: "DESKTOP_UNAVAILABLE", hint: "apt" });
      }
    });
    await assert.rejects(store().createDesktopWithApp({ projectPath: P }), ApiError);
    assert.deepEqual(store().desktops, []);
  });

  it("the launch dialog opens and closes", () => {
    store().openLaunchDialog({ projectPath: P, targetDesktopId: null });
    assert.deepEqual(store().launchDialog, { projectPath: P, targetDesktopId: null });
    store().closeLaunchDialog();
    assert.equal(store().launchDialog, null);
  });
});

describe("closing a desktop tab", () => {
  it("running apps always ask first, even with session confirms off", async () => {
    const calls = stubApi();
    useAppStore.setState({
      desktops: [desktop({ id: "d1", apps: [app("a1", "running")] })],
      appConfig: { ...store().appConfig, confirmCloseSession: false }
    });
    assert.equal(store().requestCloseTab("d1"), true);
    assert.equal(store().pendingCloseTabId, "d1");
    assert.deepEqual(calls, []);

    store().confirmCloseTab();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["closeDesktop", "d1"]]);
    assert.deepEqual(store().desktops, []);
  });

  it("a desktop with no running apps closes without asking", async () => {
    const calls = stubApi();
    useAppStore.setState({ desktops: [desktop({ id: "d1", apps: [app("a1", "exited")] })] });
    assert.equal(store().requestCloseTab("d1"), false);
    assert.equal(store().pendingCloseTabId, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["closeDesktop", "d1"]]);
    assert.deepEqual(store().desktops, []);
  });

  it("a failed stop keeps the tab and says why; an already-gone desktop is dropped", async () => {
    stubApi({
      closeDesktop: async () => {
        throw new ApiError(500, "DELETE", "/api/desktops/d1", undefined, { message: "tmux refused" });
      }
    });
    useAppStore.setState({ desktops: [desktop({ id: "d1" })] });
    await store().closeTab("d1");
    assert.deepEqual(store().desktops.map((d) => d.id), ["d1"]);
    assert.match(store().notice?.message ?? "", /tmux refused/);

    stubApi({
      closeDesktop: async () => {
        throw new ApiError(404, "DELETE", "/api/desktops/d1");
      }
    });
    await store().closeTab("d1");
    assert.deepEqual(store().desktops, []);
  });
});
