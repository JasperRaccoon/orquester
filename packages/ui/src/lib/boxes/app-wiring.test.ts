import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { BOXES_CHANGED_EVENT, BOXES_CHANNEL, type PluginInfo } from "@orquester/api";

import type { ApiClient } from "../api-client.ts";
import { useAppStore } from "../../store/app.ts";
import { boxesStore, resetBoxes } from "./store.ts";
import { box, change, kind, provider } from "./fixtures.test-helpers.ts";

const TOTALS = { activeCount: 1, hourlyUsd: 0.0119, monthEstimatedUsd: 1 };

const plugin = (enabled: boolean): PluginInfo => ({
  id: "ephemeral-vms",
  name: "Ephemeral AI VMs",
  description: "",
  source: { label: "Built in", url: "" },
  provider: "Orquester",
  scope: "global",
  updates: false,
  platform: "supported",
  enabled,
  enabledWorkspaces: [],
  current: null,
  previous: null,
  skippedVersion: null,
  lastCheckAt: null,
  lastError: null,
  job: "idle"
});

const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:1`,
  channel,
  type,
  createdAt: "2026-10-20T10:00:00.000Z",
  payload
});

function fakeApi() {
  const calls: string[] = [];
  const api = {
    connection: { id: "c1" },
    listBoxes: async () => (calls.push("boxes"), { boxes: [box()], totals: TOTALS }),
    listBoxProviders: async () => (calls.push("providers"), { providers: [provider()] }),
    listBoxKinds: async () => (calls.push("kinds"), { kinds: [kind()] }),
    listBoxConfigChanges: async () => (calls.push("changes"), { changes: [change()] })
  };
  return { api: api as unknown as ApiClient, calls };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("the app store wires the boxes store to the plugin", () => {
  let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

  beforeEach(() => {
    const state = useAppStore.getState();
    saved = { api: state.api, plugins: state.plugins };
    useAppStore.setState({ plugins: null });
    resetBoxes();
  });

  afterEach(() => {
    useAppStore.setState(saved);
    resetBoxes();
  });

  it("ignores boxes events until the plugins list is known", () => {
    useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box()], totals: TOTALS }));
    assert.equal(boxesStore.getState().boxes, null);
  });

  it("with the plugin off, holds the boxes events report still running, and only those", () => {
    useAppStore.setState({ plugins: [plugin(false)] });
    useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ state: "destroyed" })], totals: TOTALS }));
    assert.equal(boxesStore.getState().boxes, null);
    useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box()], totals: TOTALS }));
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b1"]);
  });

  it("loads when the plugin turns on, routes events, and keeps only the running boxes when it turns off", async () => {
    const fake = fakeApi();
    useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
    await flush();
    assert.deepEqual([...fake.calls].sort(), ["boxes", "changes", "kinds", "providers"]);
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b1"]);

    useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ id: "b2" })], totals: TOTALS }));
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);
    // Another channel's event of the same type is not this store's.
    useAppStore.getState().applyEvent(event("elsewhere", BOXES_CHANGED_EVENT, { boxes: [], totals: TOTALS }));
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);

    // Another plugin list with it still on: no reload.
    const before = fake.calls.length;
    useAppStore.setState({ plugins: [plugin(true)] });
    await flush();
    assert.equal(fake.calls.length, before);

    // Off: b2 still runs (and bills) — it stays; nothing else does.
    useAppStore.setState({ plugins: [plugin(false)] });
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b2"]);
    assert.equal(boxesStore.getState().providers, null);
    assert.equal(boxesStore.getState().kinds, null);
    // Destroyed: nothing is left running, so nothing is held.
    useAppStore.getState().applyEvent(event(BOXES_CHANNEL, BOXES_CHANGED_EVENT, { boxes: [box({ id: "b2", state: "destroyed" })], totals: TOTALS }));
    assert.equal(boxesStore.getState().boxes, null);
  });

  it("turning off with nothing running forgets everything", async () => {
    const fake = fakeApi();
    (fake.api as { listBoxes: unknown }).listBoxes = async () => ({ boxes: [box({ state: "destroyed" })], totals: TOTALS });
    useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
    await flush();
    assert.equal(boxesStore.getState().boxes?.length, 1);
    useAppStore.setState({ plugins: [plugin(false)] });
    assert.equal(boxesStore.getState().boxes, null);
    assert.equal(boxesStore.getState().providers, null);
  });

  it("a connection switch's empty plugin list forgets the boxes", async () => {
    const fake = fakeApi();
    useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
    await flush();
    assert.ok(boxesStore.getState().boxes);
    useAppStore.setState({ plugins: null });
    assert.equal(boxesStore.getState().boxes, null);
  });
});
