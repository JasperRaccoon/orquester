import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { PluginInfo, SecretVaultDetail } from "@orquester/api";

import type { ApiClient } from "../api-client.ts";
import { useAppStore } from "../../store/app.ts";
import { getSecretVault, resetSecretFiles } from "./store.ts";

const WS = "jaspersito";
const KEY = "github.com/jasperraccoon/matssmile";

const vault: SecretVaultDetail = {
  workspace: WS,
  repoKey: KEY,
  fileCount: 0,
  clonesNeedingAttention: 0,
  newCandidates: 0,
  updatedAt: "2026-10-19T10:00:00.000Z",
  files: [],
  excluded: [],
  candidates: [],
  clones: []
};

const plugin = (enabled: boolean): PluginInfo => ({
  id: "secret-files",
  name: "Secret files",
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

const event = (channel: string, payload: unknown) => ({
  id: `${channel}:1`,
  channel,
  type: "secretFiles.changed",
  createdAt: "2026-10-19T10:00:00.000Z",
  payload
});

function fakeApi() {
  const calls: string[] = [];
  const api = {
    connection: { id: "c1" },
    listSecretVaults: async () => {
      calls.push("list");
      return { vaults: [{ workspace: WS, repoKey: KEY }] };
    },
    getSecretVault: async () => {
      calls.push("get");
      return { vault };
    }
  };
  return { api: api as unknown as ApiClient, calls };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("the app store wires the secret-files store to the plugin", () => {
  let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

  beforeEach(() => {
    const state = useAppStore.getState();
    saved = { api: state.api, plugins: state.plugins };
    useAppStore.setState({ plugins: null });
    resetSecretFiles();
  });

  afterEach(() => {
    useAppStore.setState(saved);
    resetSecretFiles();
  });

  it("ignores secret-files events while the plugin is off", () => {
    useAppStore.getState().applyEvent(event("secret-files", { vault }));
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("loads the vaults when the plugin turns on, routes events, and forgets them when it turns off", async () => {
    const fake = fakeApi();
    useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
    await flush();
    assert.deepEqual(fake.calls, ["list", "get"]);
    assert.ok(getSecretVault(WS, KEY));

    useAppStore.getState().applyEvent(event("secret-files", { workspace: WS, repoKey: KEY, deleted: true }));
    assert.equal(getSecretVault(WS, KEY), undefined);
    useAppStore.getState().applyEvent(event("secret-files", { vault: { ...vault, updatedAt: "2026-10-19T11:00:00.000Z" } }));
    assert.ok(getSecretVault(WS, KEY));
    useAppStore.getState().applyEvent(event("elsewhere", { workspace: WS, repoKey: KEY, deleted: true }));
    assert.ok(getSecretVault(WS, KEY));

    // Another plugin list with it still on: no reload.
    useAppStore.setState({ plugins: [plugin(true)] });
    await flush();
    assert.equal(fake.calls.length, 2);

    useAppStore.setState({ plugins: [plugin(false)] });
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("a connection switch's empty plugin list forgets the vaults", async () => {
    const fake = fakeApi();
    useAppStore.setState({ api: fake.api, plugins: [plugin(true)] });
    await flush();
    assert.ok(getSecretVault(WS, KEY));
    useAppStore.setState({ plugins: null });
    assert.equal(getSecretVault(WS, KEY), undefined);
  });
});
