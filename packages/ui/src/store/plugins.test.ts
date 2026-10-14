/**
 * Built-in plugins in the app store (spec §5.3, §6): the `plugins` channel's
 * broadcast and the section's load, run on the actual store with a stub API
 * client.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { PLUGINS_CHANGED_EVENT, PLUGINS_CHANNEL, type PluginInfo } from "@orquester/api";

import type { ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "ts-rust",
    name: "Better TS Typecheck",
    description: "Runs tsc-rs instead of tsc.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    platform: "supported",
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle",
    ...overrides
  };
}

const event = (type: string, payload: unknown) => ({
  id: `${PLUGINS_CHANNEL}:${type}`,
  channel: PLUGINS_CHANNEL,
  type,
  createdAt: "2026-10-14T10:00:00.000Z",
  payload
});

const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ api: null, plugins: null });
});

describe("plugins channel events", () => {
  it("a change replaces the whole list", () => {
    store().applyEvent(event(PLUGINS_CHANGED_EVENT, { plugins: [plugin({ job: "installing" })] }));
    assert.equal(store().plugins?.[0]?.job, "installing");
    store().applyEvent(event(PLUGINS_CHANGED_EVENT, { plugins: [plugin({ enabledWorkspaces: ["acme"] })] }));
    assert.deepEqual(store().plugins, [plugin({ enabledWorkspaces: ["acme"] })]);
  });

  it("malformed payloads and other event types never reach state", () => {
    useAppStore.setState({ plugins: [plugin()] });
    store().applyEvent(event(PLUGINS_CHANGED_EVENT, { plugins: [{ ...plugin(), job: "busy" }] }));
    store().applyEvent(event(PLUGINS_CHANGED_EVENT, "nope"));
    store().applyEvent(event(PLUGINS_CHANGED_EVENT, null));
    store().applyEvent(event("plugins.other", { plugins: [] }));
    assert.deepEqual(store().plugins, [plugin()]);
  });
});

describe("loadPlugins", () => {
  it("stores the daemon's list", async () => {
    const api = { getPlugins: async () => ({ plugins: [plugin({ enabledWorkspaces: ["acme"] })] }) };
    useAppStore.setState({ api: api as unknown as ApiClient });
    await store().loadPlugins();
    assert.deepEqual(store().plugins, [plugin({ enabledWorkspaces: ["acme"] })]);
  });

  it("rejects with the request's error and keeps the last list", async () => {
    const failure = new Error("offline");
    const api = {
      getPlugins: async () => {
        throw failure;
      }
    };
    useAppStore.setState({ api: api as unknown as ApiClient, plugins: [plugin()] });
    await assert.rejects(store().loadPlugins(), failure);
    assert.deepEqual(store().plugins, [plugin()]);
  });

  it("drops an answer that lands after a connection switch", async () => {
    let answer!: (value: { plugins: PluginInfo[] }) => void;
    const previous = {
      getPlugins: () => new Promise<{ plugins: PluginInfo[] }>((resolve) => (answer = resolve))
    };
    useAppStore.setState({ api: previous as unknown as ApiClient });
    const loading = store().loadPlugins();
    useAppStore.setState({ api: {} as unknown as ApiClient, plugins: null });
    answer({ plugins: [plugin()] });
    await loading;
    assert.equal(store().plugins, null);
  });
});

describe("upsertPlugin", () => {
  it("applies one plugin's state from a route's answer", () => {
    useAppStore.setState({ plugins: [plugin()] });
    store().upsertPlugin(plugin({ enabledWorkspaces: ["acme"] }));
    assert.deepEqual(store().plugins, [plugin({ enabledWorkspaces: ["acme"] })]);
  });
});
