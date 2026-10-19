import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { useAppStore } from "../../store/app.ts";
import { getRepoIdentity, resetRepoIdentities } from "./store.ts";

const KEY = "github.com/jasperraccoon/jasperengine";
const record = { repoKey: KEY, label: "Engine", updatedAt: "2026-10-18T10:00:00.000Z" };

const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:${type}`,
  channel,
  type,
  createdAt: "2026-10-18T10:00:00.000Z",
  payload
});

describe("the app store routes repo identity events", () => {
  it("a change and a delete on the repo-identities channel reach the store", () => {
    resetRepoIdentities();
    useAppStore.getState().applyEvent(event("repo-identities", "repoIdentity.changed", { identity: record }));
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
    useAppStore.getState().applyEvent(event("repo-identities", "repoIdentity.changed", { repoKey: KEY, deleted: true }));
    assert.equal(getRepoIdentity(KEY), undefined);
  });

  it("the same message on another channel does not", () => {
    resetRepoIdentities();
    useAppStore.getState().applyEvent(event("elsewhere", "repoIdentity.changed", { identity: record }));
    assert.equal(getRepoIdentity(KEY), undefined);
  });
});
