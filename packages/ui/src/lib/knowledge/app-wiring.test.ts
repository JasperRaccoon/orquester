/**
 * The app store and the Knowledge Graph plugin: the knowledge store loads when
 * the plugin turns on, takes `knowledge` events only while it is on, and
 * forgets everything when it turns off; the Knowledge tab opens once per
 * project and carries the item it was asked to show.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, type PluginInfo, type ProjectSummary } from "@orquester/api";

import type { ApiClient } from "../api-client.ts";
import { useAppStore } from "../../store/app.ts";
import { knowledgeStore, resetKnowledge } from "./store.ts";
import { collections, event, flush, knowledgePlugin, status } from "./fixtures.test-helpers.ts";

function fakeApi() {
  const calls: string[] = [];
  const api = {
    connection: { id: "c1" },
    getKnowledgeStatus: async () => (calls.push("status"), status()),
    listKnowledgeCollections: async () => (calls.push("collections"), collections())
  };
  return { api: api as unknown as ApiClient, calls };
}

describe("the app store wires the knowledge store to the plugin", () => {
  let saved: { api: ApiClient | null; plugins: PluginInfo[] | null };

  beforeEach(() => {
    const state = useAppStore.getState();
    saved = { api: state.api, plugins: state.plugins };
    useAppStore.setState({ plugins: null });
    resetKnowledge();
  });

  afterEach(() => {
    useAppStore.setState(saved);
    resetKnowledge();
  });

  it("ignores knowledge events while the plugin is off", () => {
    useAppStore.setState({ plugins: [knowledgePlugin(false)] });
    useAppStore.getState().applyEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status()));
    assert.equal(knowledgeStore.getState().status, null);
  });

  it("loads when the plugin turns on, routes its events, and forgets everything when it turns off", async () => {
    const fake = fakeApi();
    useAppStore.setState({ api: fake.api, plugins: [knowledgePlugin(true)] });
    await flush();
    assert.deepEqual([...fake.calls].sort(), ["collections", "status"]);
    assert.equal(knowledgeStore.getState().status?.entries, 2);

    useAppStore.getState().applyEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status({ entries: 8 })));
    assert.equal(knowledgeStore.getState().status?.entries, 8);
    // Another channel's event of the same type is not this store's.
    useAppStore.getState().applyEvent(event("elsewhere", KNOWLEDGE_STATUS_EVENT, status({ entries: 1 })));
    assert.equal(knowledgeStore.getState().status?.entries, 8);

    // Another plugin list with it still on: no reload.
    const before = fake.calls.length;
    useAppStore.setState({ plugins: [knowledgePlugin(true)] });
    await flush();
    assert.equal(fake.calls.length, before);

    useAppStore.setState({ plugins: [knowledgePlugin(false)] });
    assert.equal(knowledgeStore.getState().status, null);
    assert.equal(knowledgeStore.getState().collections, null);
  });
});

describe("the Knowledge tab", () => {
  const P = "/w/acme/app";
  const Q = "/w/acme/site";
  const project = (path: string) => ({ name: path.split("/").pop(), workspace: "acme", path }) as ProjectSummary;
  const store = () => useAppStore.getState();

  beforeEach(() => {
    useAppStore.setState({
      api: null,
      currentProject: project(P),
      knowledgeTabsByProject: {},
      whiteboardTabsByProject: {},
      activeTabByProject: {},
      sessions: [],
      browsers: [],
      desktops: []
    });
  });

  it("opens once per project and focuses the open one again", () => {
    store().openKnowledge();
    const [tab] = store().knowledgeTabsByProject[P] ?? [];
    assert.ok(tab);
    assert.equal(tab.title, "Knowledge");
    assert.equal(tab.focus, null);
    assert.equal(store().activeTabByProject[P], tab.id);

    useAppStore.setState({ activeTabByProject: { [P]: null } });
    store().openKnowledge();
    assert.equal(store().knowledgeTabsByProject[P]?.length, 1);
    assert.equal(store().activeTabByProject[P], tab.id);
  });

  it("openKnowledgeEntry selects the entry, with a new nonce each time", () => {
    store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
    const first = store().knowledgeTabsByProject[P]?.[0]?.focus;
    assert.equal(first?.kind, "entry");
    assert.equal(first?.id, "ke_aaaaaaaaaaaa");
    store().openKnowledgeEntry("ke_aaaaaaaaaaaa");
    const second = store().knowledgeTabsByProject[P]?.[0]?.focus;
    assert.ok(second && first && second.nonce > first.nonce, "the same citation clicked again asks again");
    assert.equal(store().knowledgeTabsByProject[P]?.length, 1);

    store().openKnowledgeConcept("tactic-alternatives");
    assert.equal(store().knowledgeTabsByProject[P]?.[0]?.focus?.kind, "concept");
    // A plain open keeps what the tab was showing.
    store().openKnowledge();
    assert.equal(store().knowledgeTabsByProject[P]?.[0]?.focus?.id, "tactic-alternatives");
  });

  it("opens in the project it is given, else the current one, and nowhere outside a project", () => {
    store().openKnowledgeEntry("ke_aaaaaaaaaaaa", Q);
    assert.equal(store().knowledgeTabsByProject[Q]?.length, 1);
    assert.equal(store().knowledgeTabsByProject[P], undefined);
    useAppStore.setState({ currentProject: null });
    store().openKnowledge();
    assert.equal(store().knowledgeTabsByProject[P], undefined);
  });

  it("appears among the project's tabs and closes like a client-local tab", async () => {
    store().openWhiteboard(`${P}/whiteboards/Plan.excalidraw`);
    store().openKnowledge();
    const knowledge = store().knowledgeTabsByProject[P]![0]!;
    const whiteboard = store().whiteboardTabsByProject[P]![0]!;
    await store().closeTab(knowledge.id);
    assert.deepEqual(store().knowledgeTabsByProject[P], []);
    assert.equal(store().activeTabByProject[P], whiteboard.id);
  });
});
