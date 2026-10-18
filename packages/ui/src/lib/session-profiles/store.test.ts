/**
 * The Agent Profiles store: loads sanitize field by field (secrets never
 * carried), a toggle carries the held revision, a stale revision (409) reloads
 * and says so, and `/events` refetch, drop and move readiness.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { SessionProfileDetail, SessionProfileSummary } from "@orquester/api";

import {
  applySessionProfileEvent,
  deleteSessionProfile,
  deleteSessionProfileItem,
  loadProfileWorkflowUses,
  loadSessionProfile,
  loadSessionProfiles,
  openSessionProfile,
  resetSessionProfiles,
  sessionProfilesStore,
  setSessionProfileItemEnabled,
  type SessionProfilesApi
} from "./store.ts";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const preparation = (state: "ready" | "preparing" | "failed" | "not-prepared" = "not-prepared") =>
  (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({ agent, state, updatedAt: "t" }));

function summary(id: string, revision: string, extra: Partial<SessionProfileSummary> = {}): SessionProfileSummary {
  const zero = { total: 0, enabled: 0 };
  return {
    id,
    name: id,
    description: "",
    revision,
    createdAt: "t",
    updatedAt: "t",
    counts: { mcp: zero, skill: zero, plugin: zero, hook: zero, command: zero },
    hasInstructions: false,
    preparation: preparation(),
    ...extra
  };
}

function detail(id: string, revision: string, enabled = true): SessionProfileDetail {
  return {
    ...summary(id, revision),
    settings: { hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true }, claudeWorkflowTool: true },
    items: [
      {
        id: "i1",
        kind: "mcp",
        name: "jira",
        enabled,
        agents: "all",
        // A daemon that leaked a value: the store must not carry it.
        mcp: { name: "jira", transport: "stdio", command: "npx", env: [{ key: "TOKEN", set: true, value: "s3cret" } as never] }
      }
    ],
    itemErrors: []
  };
}

interface Calls {
  list: number;
  get: string[];
  toggles: { profileId: string; itemId: string; revision: string; enabled: boolean }[];
}

function fakeApi(overrides: Partial<SessionProfilesApi> = {}): { api: SessionProfilesApi; calls: Calls; server: { revision: string } } {
  const calls: Calls = { list: 0, get: [], toggles: [] };
  const server = { revision: "1" };
  const api: SessionProfilesApi = {
    connection: { id: "c1" },
    listSessionProfiles: async () => {
      calls.list += 1;
      return { profiles: [summary("p1", server.revision), { id: 5 }], errors: [] };
    },
    getSessionProfile: async (profileId) => {
      calls.get.push(profileId);
      return detail(profileId, server.revision);
    },
    createSessionProfile: async () => detail("p-new", "1"),
    updateSessionProfile: async (profileId) => detail(profileId, server.revision),
    deleteSessionProfile: async (profileId) => ({ profileId, deleted: true }),
    duplicateSessionProfile: async () => detail("p-copy", "1"),
    setSessionProfileItemEnabled: async (profileId, itemId, revision, enabled) => {
      calls.toggles.push({ profileId, itemId, revision, enabled });
      server.revision = String(Number(server.revision) + 1);
      return { profile: detail(profileId, server.revision, enabled), itemId };
    },
    deleteSessionProfileItem: async (profileId) => ({ profile: detail(profileId, server.revision) }),
    getProfileWorkflowReferences: async (profileId) => ({ version: 1, profileId, workflows: [] }),
    ...overrides
  };
  return { api, calls, server };
}

const state = () => sessionProfilesStore.getState();

beforeEach(() => resetSessionProfiles());

describe("session profiles store", () => {
  it("loads the list and a profile, dropping what does not read and every secret value", async () => {
    const { api } = fakeApi();
    await loadSessionProfiles(api);
    assert.deepEqual(state().list.profiles?.map((p) => p.id), ["p1"], "the malformed summary is dropped");
    await loadSessionProfile(api, "p1");
    const item = state().details.p1?.detail?.items[0];
    assert.equal(item?.kind, "mcp");
    assert.deepEqual(item?.kind === "mcp" ? item.mcp.env : null, [{ key: "TOKEN", set: true }]);
    assert.equal(JSON.stringify(state()).includes("s3cret"), false);
  });

  it("a toggle carries the held revision and folds the answer in", async () => {
    const { api, calls } = fakeApi();
    await loadSessionProfiles(api);
    await loadSessionProfile(api, "p1");
    const item = state().details.p1!.detail!.items[0]!;
    const result = await setSessionProfileItemEnabled(api, "p1", item, false);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.toggles, [{ profileId: "p1", itemId: "i1", revision: "1", enabled: false }]);
    assert.equal(state().details.p1?.detail?.revision, "2");
    assert.equal(state().details.p1?.detail?.items[0]?.enabled, false);
    assert.equal(state().list.profiles?.[0]?.revision, "2", "the list's summary follows");
    assert.equal(state().pending.size, 0);
  });

  it("a stale revision (409) reloads the profile and says so", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      status: 409,
      body: { error: { code: "PROFILE_CONFLICT", message: "The profile changed." } }
    });
    const { api, calls, server } = fakeApi({
      setSessionProfileItemEnabled: async () => {
        throw conflict;
      }
    });
    await loadSessionProfile(api, "p1");
    server.revision = "7";
    const result = await setSessionProfileItemEnabled(api, "p1", state().details.p1!.detail!.items[0]!, false);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "PROFILE_CONFLICT");
    await settle();
    assert.equal(calls.get.length, 2, "reloaded");
    assert.equal(state().details.p1?.detail?.revision, "7");
    assert.match(state().notice?.text ?? "", /changed elsewhere/);
    assert.equal(state().notice?.tone, "error");
  });

  it("rapid mutations of one profile are serialized: each carries the revision the previous one answered", async () => {
    const conflict = () =>
      Object.assign(new Error("conflict"), { status: 409, body: { error: { code: "PROFILE_CONFLICT", message: "stale" } } });
    const { api, calls, server } = fakeApi({
      setSessionProfileItemEnabled: async (profileId, itemId, revision, enabled) => {
        calls.toggles.push({ profileId, itemId, revision, enabled });
        if (revision !== server.revision) throw conflict();
        server.revision = String(Number(server.revision) + 1);
        return { profile: detail(profileId, server.revision, enabled), itemId };
      },
      deleteSessionProfileItem: async (profileId, _itemId, revision) => {
        if (revision !== server.revision) throw conflict();
        server.revision = String(Number(server.revision) + 1);
        return { profile: detail(profileId, server.revision) };
      }
    });
    await loadSessionProfiles(api);
    await loadSessionProfile(api, "p1");
    const item = state().details.p1!.detail!.items[0]!;
    const results = await Promise.all([
      setSessionProfileItemEnabled(api, "p1", item, false),
      setSessionProfileItemEnabled(api, "p1", item, true),
      deleteSessionProfileItem(api, "p1", item)
    ]);
    assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
    assert.deepEqual(calls.toggles.map((toggle) => toggle.revision), ["1", "2"]);
    assert.equal(state().details.p1?.detail?.revision, "4");
    assert.equal(state().notice?.tone, "ok", "no conflict notice");
    assert.equal(state().pending.size, 0);
  });

  it("a failed mutation does not block the next one of the same profile", async () => {
    let fail = true;
    const { api, server } = fakeApi({
      setSessionProfileItemEnabled: async (profileId, itemId, _revision, enabled) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("boom"), { status: 500, body: { error: { code: "X", message: "boom" } } });
        }
        server.revision = String(Number(server.revision) + 1);
        return { profile: detail(profileId, server.revision, enabled), itemId };
      }
    });
    await loadSessionProfile(api, "p1");
    const item = state().details.p1!.detail!.items[0]!;
    const [first, second] = await Promise.all([
      setSessionProfileItemEnabled(api, "p1", item, false),
      setSessionProfileItemEnabled(api, "p1", item, false)
    ]);
    assert.equal(first.ok, false);
    assert.equal(second.ok, true);
    assert.equal(state().details.p1?.detail?.revision, "2");
  });

  it("events: a moved revision refetches, prepare status moves readiness, a delete drops the profile", async () => {
    const { api, calls, server } = fakeApi();
    await loadSessionProfiles(api);
    await loadSessionProfile(api, "p1");
    openSessionProfile("p1");

    applySessionProfileEvent({ type: "sessionProfile.changed", payload: { profileId: "p1", revision: "1" } });
    await settle();
    assert.equal(calls.get.length, 1, "the revision held: nothing to fetch");

    server.revision = "2";
    applySessionProfileEvent({ type: "sessionProfile.changed", payload: { profileId: "p1", revision: "2" } });
    await settle();
    assert.equal(calls.get.length, 2);
    assert.equal(calls.list, 2);
    assert.equal(state().details.p1?.detail?.revision, "2");

    applySessionProfileEvent({
      type: "sessionProfile.prepareStatus",
      payload: { profileId: "p1", revision: "2", agents: [{ agent: "codex", state: "preparing", updatedAt: "t" }] }
    });
    const codex = state().details.p1?.detail?.preparation.find((status) => status.agent === "codex");
    assert.equal(codex?.state, "preparing");
    assert.equal(state().list.profiles?.[0]?.preparation.find((status) => status.agent === "codex")?.state, "preparing");

    applySessionProfileEvent({
      type: "sessionProfile.prepareStatus",
      payload: { profileId: "p1", revision: "1", agents: [{ agent: "codex", state: "failed", updatedAt: "t" }] }
    });
    assert.equal(
      state().details.p1?.detail?.preparation.find((status) => status.agent === "codex")?.state,
      "preparing",
      "an older revision's status is not this one's"
    );

    applySessionProfileEvent({ type: "sessionProfile.changed", payload: "garbage" });
    applySessionProfileEvent({ type: "sessionProfile.deleted", payload: { profileId: "p1" } });
    assert.equal(state().list.profiles?.length, 0);
    assert.equal(state().details.p1, undefined);
    assert.equal(state().openProfileId, null, "the open editor goes back to the library");
    assert.match(state().notice?.text ?? "", /was deleted/);
  });

  it("deleting a profile sends its revision and drops it", async () => {
    const seen: string[] = [];
    const { api } = fakeApi({
      deleteSessionProfile: async (profileId, revision) => {
        seen.push(`${profileId}@${revision}`);
        return { profileId, deleted: true };
      }
    });
    await loadSessionProfiles(api);
    await loadSessionProfile(api, "p1");
    const result = await deleteSessionProfile(api, "p1");
    assert.equal(result.ok, true);
    assert.deepEqual(seen, ["p1@1"]);
    assert.equal(state().list.profiles?.length, 0);
  });

  it("the delete guard: the workflows using a profile, read field-wise; unknown when the daemon cannot tell or the answer does not read", async () => {
    const answer = (body: unknown) => fakeApi({ getProfileWorkflowReferences: async () => body }).api;
    const use = { workflowId: "wf_1", name: "Nightly", enabled: true, revision: 2, project: { kind: "existing", projectPath: "/w/a/b" }, workspace: "a", nodes: [] };
    assert.deepEqual(await loadProfileWorkflowUses(answer({ version: 1, profileId: "p1", workflows: [use, use, { name: "no id" }] }), "p1"), {
      ok: true, workflows: [{ workflowId: "wf_1", name: "Nightly", enabled: true, workspace: "a" }], unknown: true
    }, "a row that does not read makes the list incomplete");
    assert.deepEqual(await loadProfileWorkflowUses(answer({ version: 1, profileId: "p1", workflows: [], unknownReason: "not loaded" }), "p1"), { ok: true, workflows: [], unknown: true });
    assert.deepEqual(await loadProfileWorkflowUses(answer("nonsense"), "p1"), { ok: true, workflows: [], unknown: true });
    assert.deepEqual(await loadProfileWorkflowUses(answer({ version: 1, profileId: "p1", workflows: [] }), "p1"), { ok: true, workflows: [], unknown: false });
    const failing = fakeApi({ getProfileWorkflowReferences: async () => { throw Object.assign(new Error("boom"), { status: 500, body: { error: { code: "X", message: "boom" } } }); } }).api;
    assert.equal((await loadProfileWorkflowUses(failing, "p1")).ok, false);
  });

  it("the delete guard: the confirmed workflow ids ride the delete; a 409 WORKFLOW_USES_CHANGED keeps the profile and says why", async () => {
    const seen: unknown[] = [];
    let refuse = true;
    const { api } = fakeApi({
      deleteSessionProfile: async (profileId, revision, options) => {
        seen.push([revision, options]);
        if (refuse) {
          throw Object.assign(new Error("changed"), {
            status: 409,
            body: { error: { code: "WORKFLOW_USES_CHANGED", message: 'The workflows that use this profile changed (now: "Nightly"); nothing was deleted.' } }
          });
        }
        return { profileId, deleted: true };
      }
    });
    await loadSessionProfiles(api);
    await loadSessionProfile(api, "p1");
    const refused = await deleteSessionProfile(api, "p1", { expectWorkflowUses: [] });
    assert.deepEqual(refused, { ok: false, error: 'The workflows that use this profile changed (now: "Nightly"); nothing was deleted.', code: "WORKFLOW_USES_CHANGED" });
    assert.equal(state().list.profiles?.length, 1, "still there");
    assert.match(state().notice?.text ?? "", /now: "Nightly"/);
    refuse = false;
    assert.equal((await deleteSessionProfile(api, "p1", { expectWorkflowUses: ["wf_1"] })).ok, true);
    assert.deepEqual(seen, [["1", { expectWorkflowUses: [] }], ["1", { expectWorkflowUses: ["wf_1"] }]]);
    assert.equal(state().list.profiles?.length, 0);
  });

  it("a client of another connection starts over", async () => {
    const { api } = fakeApi();
    await loadSessionProfiles(api);
    const other = fakeApi({ listSessionProfiles: async () => ({ profiles: [], errors: [] }) });
    (other.api as { connection: { id: string } }).connection = { id: "c2" };
    await loadSessionProfiles(other.api);
    assert.deepEqual(state().list.profiles, []);
  });
});
