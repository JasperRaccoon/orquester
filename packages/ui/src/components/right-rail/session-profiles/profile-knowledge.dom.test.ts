/**
 * The Agent Profile settings dialog's "Knowledge" section: shown only while
 * the Knowledge Graph plugin is on, one checkbox per collection (name, dot,
 * description), and a round trip through the form to the update patch that
 * keeps the ids of collections deleted since.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionProfileDetail } from "@orquester/api";

import { collection, collections, knowledgePlugin } from "../../../lib/knowledge/fixtures.test-helpers";
import type { ProfileSettingsForm } from "./ProfileSettingsDialog";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../../store/app").useAppStore;
let knowledgeStore: typeof import("../../../lib/knowledge/store").knowledgeStore;
let resetKnowledge: typeof import("../../../lib/knowledge/store").resetKnowledge;
let dialog: typeof import("./ProfileSettingsDialog");

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore } = await import("../../../store/app"));
  ({ knowledgeStore, resetKnowledge } = await import("../../../lib/knowledge/store"));
  dialog = await import("./ProfileSettingsDialog");
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function profile(knowledgeCollections?: string[]): SessionProfileDetail {
  return {
    id: "p1",
    name: "SaaS expert",
    description: "",
    revision: "1",
    createdAt: "t",
    updatedAt: "t",
    counts: {
      mcp: { total: 0, enabled: 0 },
      skill: { total: 0, enabled: 0 },
      plugin: { total: 0, enabled: 0 },
      hook: { total: 0, enabled: 0 },
      command: { total: 0, enabled: 0 }
    },
    hasInstructions: false,
    preparation: [],
    settings: {
      hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true },
      claudeWorkflowTool: true,
      ...(knowledgeCollections ? { knowledgeCollections } : {})
    },
    items: [],
    itemErrors: []
  } as SessionProfileDetail;
}

describe("profile knowledge collections (pure)", () => {

  it("drops deleted ids first when the list would pass its cap", () => {
    const live = Array.from({ length: 99 }, (_, i) => `kc_${i}`);
    const next = dialog.toggleKnowledgeCollection(["kc_gone", ...live], "kc_new", true, [...live, "kc_new"]);
    assert.equal(next.length, 100);
    assert.ok(!next.includes("kc_gone"));
    assert.ok(next.includes("kc_new"));
  });

  it("sends the list only when the ticked set changed", () => {
    const stored = profile(["kc_gone", "kc_seo"]);
    const form = dialog.profileSettingsForm(stored);
    assert.deepEqual(dialog.updatePatchFromForm(stored, form), {});
    const reordered: ProfileSettingsForm = { ...form, settings: { ...form.settings, knowledgeCollections: ["kc_seo", "kc_gone"] } };
    assert.deepEqual(dialog.updatePatchFromForm(stored, reordered), {});
    const none: ProfileSettingsForm = { ...form, settings: { ...form.settings, knowledgeCollections: [] } };
    assert.deepEqual(dialog.updatePatchFromForm(stored, none), { settings: { knowledgeCollections: [] } });
    // An older daemon's profile (absent = none ticked): unchanged until one is ticked.
    assert.deepEqual(dialog.updatePatchFromForm(profile(), dialog.profileSettingsForm(profile())), {});
  });

  it("a new profile carries its ticked collections, and nothing when none are", () => {
    const form = dialog.profileSettingsForm(null);
    assert.equal("knowledgeCollections" in (dialog.createRequestFromForm({ ...form, name: "A" }).settings ?? {}), false);
    const ticked = { ...form, name: "A", settings: { ...form.settings, knowledgeCollections: ["kc_seo"] } };
    assert.deepEqual(dialog.createRequestFromForm(ticked).settings?.knowledgeCollections, ["kc_seo"]);
  });
});

describe("the profile settings dialog's Knowledge section", () => {
  let root: Root;
  let submitted: ProfileSettingsForm[];
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    // The modal hands focus back a tick after it closes: run that tick here, not after the DOM is gone.
    mock.timers.enable({ apis: ["setTimeout"] });
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    submitted = [];
    resetKnowledge();
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    useAppStore.setState(initial, true);
    resetKnowledge();
  });

  const show = async (on: boolean, stored: SessionProfileDetail) => {
    useAppStore.setState({ plugins: [knowledgePlugin(on)] });
    knowledgeStore.setState({
      collections: collections([
        collection({ id: "kc_seo", name: "SEO", description: "Ranking in search engines" }),
        collection({ id: "kc_ads", name: "Ads", description: "", color: "chart-2" })
      ])
    });
    await act(async () =>
      root.render(
        createElement(dialog.ProfileSettingsDialog, {
          open: true,
          mode: "edit",
          profile: stored,
          sheet: false,
          onCancel: () => undefined,
          onSubmit: async (form: ProfileSettingsForm) => (submitted.push(form), null)
        })
      )
    );
  };

  const doc = () => dom.window.document;
  const box = (id: string) => doc().querySelector<HTMLInputElement>(`input[data-knowledge-collection="${id}"]`);
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const submit = async () => {
    const save = [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    await click(save);
    for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
  };

  it("is absent while the plugin is off", async () => {
    await show(false, profile(["kc_seo"]));
    assert.equal((doc().querySelector('fieldset[aria-label="Knowledge"]')) === null, true);
  });

  it("lists every collection with its description and the visibility line", async () => {
    await show(true, profile(["kc_seo", "kc_gone"]));
    const section = doc().querySelector('fieldset[aria-label="Knowledge"]');
    assert.ok(section);
    assert.match(section.textContent!, /Chats with this profile can only search the ticked collections\. Chats without a profile see everything\./);
    assert.match(section.textContent!, /SEO\s*Ranking in search engines/);
    assert.equal(box("kc_seo")?.checked, true);
    assert.equal(box("kc_ads")?.checked, false);
    assert.equal((box("kc_gone")) === null, true, "a deleted collection is not shown");
  });

  it("reads the collections when they never loaded, and offers a retry when the read fails", async () => {
    let fail = true;
    const reads: string[] = [];
    const api = {
      connection: { id: "c1" },
      listKnowledgeCollections: async () => {
        reads.push("collections");
        if (fail) throw Object.assign(new Error("offline"), { body: { code: "KNOWLEDGE_ERROR", message: "The server is unreachable." } });
        return collections([collection({ id: "kc_seo", name: "SEO" })]);
      }
    };
    useAppStore.setState({ plugins: [knowledgePlugin(true)], api: api as never });
    for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
    // The load when the plugin turned on failed: no collections, only the error.
    assert.equal((knowledgeStore.getState().collections) === null, true);
    reads.length = 0;
    await act(async () =>
      root.render(
        createElement(dialog.ProfileSettingsDialog, {
          open: true,
          mode: "edit",
          profile: profile(["kc_seo"]),
          sheet: false,
          onCancel: () => undefined,
          onSubmit: async () => null
        })
      )
    );
    for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
    assert.deepEqual(reads, ["collections"], "read on open");
    const section = () => doc().querySelector('fieldset[aria-label="Knowledge"]')!;
    assert.match(section().textContent!, /The server is unreachable\./);
    assert.doesNotMatch(section().textContent!, /Loading collections/);

    fail = false;
    const retry = [...section().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
    assert.ok(retry, "a retry");
    await click(retry);
    for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
    assert.equal(box("kc_seo")?.checked, true);
  });

  it("round-trips: ticking and unticking reach the patch, a deleted collection's id stays", async () => {
    const stored = profile(["kc_seo", "kc_gone"]);
    await show(true, stored);
    await click(box("kc_ads")!);
    await click(box("kc_seo")!);
    await submit();
    assert.equal(submitted.length, 1);
    assert.deepEqual(dialog.updatePatchFromForm(stored, submitted[0]!), { settings: { knowledgeCollections: ["kc_gone", "kc_ads"] } });
  });
});
