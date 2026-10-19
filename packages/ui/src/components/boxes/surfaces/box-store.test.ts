/**
 * The box surfaces' stand-in store: payloads are shape-checked before they
 * reach state (a malformed one keeps the last good copy), a load lands each
 * half on its own, a reset drops a load still in flight, events replace the
 * lists, and a decision's answer replaces the set it decided.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  BOXES_CHANGED_EVENT,
  BOXES_CHANNEL,
  BOX_CONFIG_CHANGES_EVENT,
  boxRoutes,
  type BoxConfigChangeSet,
  type BoxSummary,
  type EventMessage
} from "@orquester/api";

import {
  applyBoxSurfacesEvent,
  boxSurfacesStore,
  decideBoxConfigChange,
  destroyTemporaryBox,
  loadBoxSurfaces,
  parseBoxConfigChangeSet,
  parseBoxSummary,
  resetBoxSurfaces,
  type BoxSurfacesApi
} from "./box-store";

const BOX: BoxSummary = {
  id: "box-1",
  purpose: "project",
  kind: "linux",
  provider: "hetzner",
  providerLabel: "Hetzner",
  region: "fsn1",
  regionLabel: "Falkenstein",
  size: "cx22",
  sizeLabel: "CX22",
  image: null,
  os: "linux",
  arch: "x64",
  state: "provisioning",
  stateReason: null,
  destroyedReason: null,
  hourlyUsd: 0.01,
  estimatedCostUsd: 0,
  createdAt: "2026-10-20T10:00:00Z",
  readyAt: null,
  deadlineAt: null,
  destroyedAt: null,
  connected: false,
  lastSeenAt: null,
  project: { workspace: "ws", name: "app", path: "/w/ws/app" },
  threadId: null,
  purposeNote: null,
  setup: [{ id: "clone", label: "Clone the repository", state: "running", startedAt: null, finishedAt: null, message: null }]
};

const CHANGE: BoxConfigChangeSet = {
  id: "cc-1",
  boxId: "box-1",
  threadId: "t-1",
  createdAt: "2026-10-20T10:00:00Z",
  decidedAt: null,
  state: "pending",
  files: [{ path: "/h/.claude/settings.json", change: "modified", executable: false, diff: "+x", truncated: false, binary: false }]
};

const event = (type: string, payload: unknown): EventMessage =>
  ({ channel: BOXES_CHANNEL, type, payload, timestamp: "2026-10-20T10:00:00Z" }) as unknown as EventMessage;

/** A fake client answering from a route table; each call is recorded. */
function fakeApi(routes: Record<string, () => Promise<unknown>>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const api: BoxSurfacesApi = {
    send<T>(method: string, path: string, options?: { body?: unknown }): Promise<T> {
      calls.push({ method, path, ...(options?.body !== undefined ? { body: options.body } : {}) });
      const route = routes[`${method} ${path}`];
      return (route ? route() : Promise.reject(new Error(`no route ${method} ${path}`))) as Promise<T>;
    }
  };
  return { api, calls };
}

beforeEach(() => resetBoxSurfaces());

describe("parsing", () => {
  it("reads a well-formed box and keeps its setup steps", () => {
    assert.deepEqual(parseBoxSummary(JSON.parse(JSON.stringify(BOX))), BOX);
  });

  it("refuses what is not a box, and repairs optional fields", () => {
    assert.equal(parseBoxSummary({ ...BOX, kind: "amiga" }), null);
    assert.equal(parseBoxSummary({ ...BOX, state: "melting" }), null);
    assert.equal(parseBoxSummary({ ...BOX, id: "" }), null);
    assert.equal(parseBoxSummary("box"), null);
    const repaired = parseBoxSummary({
      ...BOX,
      destroyedReason: "meteor",
      hourlyUsd: "cheap",
      setup: [{ id: "nope" }, BOX.setup[0]],
      project: { path: 3 },
      extra: "dropped"
    });
    assert.equal(repaired?.destroyedReason, null);
    assert.equal(repaired?.hourlyUsd, null);
    assert.equal(repaired?.setup.length, 1);
    assert.equal(repaired?.project, null);
    assert.equal("extra" in (repaired ?? {}), false);
  });

  it("reads a change set, leaving out files that do not read", () => {
    assert.deepEqual(parseBoxConfigChangeSet(CHANGE), CHANGE);
    const set = parseBoxConfigChangeSet({ ...CHANGE, files: [{ path: "" }, { ...CHANGE.files[0], change: "renamed" }, CHANGE.files[0]] });
    assert.equal(set?.files.length, 1);
    assert.equal(parseBoxConfigChangeSet({ ...CHANGE, state: "maybe" }), null);
    assert.equal(parseBoxConfigChangeSet({ ...CHANGE, threadId: "" })?.threadId, null);
  });
});

describe("loading and events", () => {
  it("loads both lists", async () => {
    const { api } = fakeApi({
      [`GET ${boxRoutes.list}`]: async () => ({ boxes: [BOX], totals: {} }),
      [`GET ${boxRoutes.configChanges}`]: async () => ({ changes: [CHANGE] })
    });
    await loadBoxSurfaces(api);
    assert.deepEqual(boxSurfacesStore.getState().boxes, [BOX]);
    assert.deepEqual(boxSurfacesStore.getState().configChanges, [CHANGE]);
  });

  it("lands each half on its own when the other fails", async () => {
    const { api } = fakeApi({ [`GET ${boxRoutes.list}`]: async () => ({ boxes: [BOX] }) });
    await loadBoxSurfaces(api);
    assert.deepEqual(boxSurfacesStore.getState().boxes, [BOX]);
    assert.equal(boxSurfacesStore.getState().configChanges, null);
  });

  it("drops a load that a reset overtook", async () => {
    let answer!: (value: unknown) => void;
    const { api } = fakeApi({
      [`GET ${boxRoutes.list}`]: () => new Promise((resolve) => (answer = resolve)),
      [`GET ${boxRoutes.configChanges}`]: async () => ({ changes: [] })
    });
    const loading = loadBoxSurfaces(api);
    resetBoxSurfaces();
    answer({ boxes: [BOX] });
    await loading;
    assert.equal(boxSurfacesStore.getState().boxes, null);
  });

  it("replaces the lists from events, and keeps the last good copy on a malformed one", () => {
    applyBoxSurfacesEvent(event(BOXES_CHANGED_EVENT, { boxes: [BOX] }));
    assert.deepEqual(boxSurfacesStore.getState().boxes, [BOX]);
    applyBoxSurfacesEvent(event(BOXES_CHANGED_EVENT, { boxes: "nope" }));
    assert.deepEqual(boxSurfacesStore.getState().boxes, [BOX]);
    applyBoxSurfacesEvent(event(BOX_CONFIG_CHANGES_EVENT, { changes: [CHANGE] }));
    assert.deepEqual(boxSurfacesStore.getState().configChanges, [CHANGE]);
    applyBoxSurfacesEvent({ ...event(BOXES_CHANGED_EVENT, { boxes: [] }), channel: "sessions" } as EventMessage);
    assert.deepEqual(boxSurfacesStore.getState().boxes, [BOX], "another channel is ignored");
  });
});

describe("actions", () => {
  it("posts a decision and puts the decided set in place", async () => {
    applyBoxSurfacesEvent(event(BOX_CONFIG_CHANGES_EVENT, { changes: [CHANGE] }));
    const decided = { ...CHANGE, state: "approved", decidedAt: "2026-10-20T10:05:00Z" };
    const { api, calls } = fakeApi({ [`POST ${boxRoutes.configChange("cc-1")}`]: async () => ({ change: decided }) });
    const answer = await decideBoxConfigChange(api, "cc-1", "approve");
    assert.deepEqual(calls, [{ method: "POST", path: boxRoutes.configChange("cc-1"), body: { decision: "approve" } }]);
    assert.equal(answer?.state, "approved");
    assert.equal(boxSurfacesStore.getState().configChanges?.[0]?.state, "approved");
  });

  it("destroys a temporary box with DELETE", async () => {
    const { api, calls } = fakeApi({ [`DELETE ${boxRoutes.box("tmp 1")}`]: async () => undefined });
    await destroyTemporaryBox(api, "tmp 1");
    assert.deepEqual(calls, [{ method: "DELETE", path: "/api/boxes/tmp%201" }]);
  });
});
