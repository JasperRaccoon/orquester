/**
 * A repo group's header in a DOM (spec 2026-10-18 §1, §3): it toggles its
 * saved collapse, its "+" starts a fresh clone, and its ⋯ menu renames the
 * label inline — a blank name resets it, a bad one stays open with the reason.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  SECRET_FILES_PLUGIN_ID,
  type PluginInfo,
  type SecretVaultDetail,
  type SetRepoLabelRequest
} from "@orquester/api";

import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
import type { RepoProjectGroup } from "../../lib/repo-groups";
import { applyRepoIdentity, resetRepoIdentities } from "../../lib/repo-identities/store";
import { applySecretVault, resetSecretFiles } from "../../lib/secret-files/store";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let RepoGroupSection: typeof import("./RepoGroupSection").RepoGroupSection;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ RepoGroupSection } = await import("./RepoGroupSection"));
  ({ useAppStore } = await import("../../store/app"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const KEY = "github.com/jasperraccoon/jasperengine";

const group = (overrides: Partial<RepoProjectGroup> = {}): RepoProjectGroup => ({
  repoKey: KEY,
  label: "JasperRaccoon/JasperEngine",
  defaultLabel: "JasperRaccoon/JasperEngine",
  cloneUrl: "https://github.com/JasperRaccoon/JasperEngine.git",
  projects: [
    { name: "JasperEngine", workspace: "ws", path: "/w/ws/JasperEngine", repoKey: KEY },
    { name: "Multiplayer", workspace: "ws", path: "/w/ws/Multiplayer", repoKey: KEY }
  ],
  collapsed: false,
  pinnedOpen: false,
  ...overrides
});

describe("a repo group header", () => {
  let root: Root;
  let labels: SetRepoLabelRequest[];
  let clones: number;

  const fakeApi = {
    setRepoLabel: async (req: SetRepoLabelRequest) => {
      labels.push(req);
      return {
        identity: req.label === null ? null : { repoKey: req.repoKey, label: req.label, updatedAt: "2026-10-19T00:00:00Z" }
      };
    },
    // The Secret files dialog asks for its vault when it opens; it never answers here.
    getSecretVault: () => new Promise(() => undefined)
  } as unknown as ApiClient;

  const render = async (g: RepoProjectGroup) => {
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: fakeApi,
          useTitlebar: false,
          children: createElement(RepoGroupSection, {
            workspace: "ws",
            group: g,
            onClone: () => {
              clones += 1;
            },
            children: g.projects.map((p) => createElement("div", { key: p.path, "data-row": p.name }, p.name))
          })
        })
      );
    });
  };

  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const menuLabels = () =>
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
  const openMenu = async (label = "JasperRaccoon/JasperEngine") => {
    await act(async () => button(`Actions for ${label}`)!.click());
  };
  const pick = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === label
    );
    assert.ok(item, `menu has ${label}`);
    await act(async () => item.click());
  };
  const type = async (value: string, key = "Enter") => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Repo label"]')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
  };

  beforeEach(() => {
    labels = [];
    clones = 0;
    resetRepoIdentities();
    localStorage.clear();
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("shows its label, count and rows, and its '+' asks for a fresh clone", async () => {
    await render(group());
    const header = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    assert.equal(header.getAttribute("aria-expanded"), "true");
    assert.equal(header.title, KEY);
    assert.match(header.textContent ?? "", /JasperRaccoon\/JasperEngine\s*2/);
    assert.equal(document.querySelectorAll("[data-row]").length, 2);
    await act(async () => button("New clone of JasperRaccoon/JasperEngine")!.click());
    assert.equal(clones, 1);
  });

  it("hides its rows when collapsed and saves the toggle", async () => {
    await render(group({ collapsed: true }));
    assert.equal(document.querySelectorAll("[data-row]").length, 0);
    await render(group());
    await act(async () => document.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    assert.deepEqual(JSON.parse(localStorage.getItem("orquester:collapsed-repo-groups") ?? "[]"), [KEY]);
  });

  it("offers Reset label only while a custom label is set", async () => {
    await render(group());
    await openMenu();
    assert.deepEqual(menuLabels(), ["Change icon…", "Rename label…", "Copy repo id"]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => applyRepoIdentity(KEY, { repoKey: KEY, label: "Engine", updatedAt: "x" }));
    await openMenu();
    assert.deepEqual(menuLabels(), ["Change icon…", "Rename label…", "Copy repo id", "Reset label"]);
    await pick("Reset label");
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    assert.deepEqual(labels, [{ repoKey: KEY, label: null }]);
  });

  it("renames inline: a new label is saved, a blank one resets to the default", async () => {
    await render(group());
    await openMenu();
    await pick("Rename label…");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Repo label"]');
    assert.equal(input?.value, "JasperRaccoon/JasperEngine");
    await type("  Engine  ");
    assert.deepEqual(labels, [{ repoKey: KEY, label: "Engine" }]);
    assert.equal(document.querySelector('input[aria-label="Repo label"]'), null);

    await render(group({ label: "Engine" }));
    await openMenu("Engine");
    await pick("Rename label…");
    await type("   ");
    assert.deepEqual(labels.at(-1), { repoKey: KEY, label: null });
  });

  it("keeps a bad label open with the reason, and Escape leaves it unsaved", async () => {
    await render(group());
    await openMenu();
    await pick("Rename label…");
    await type("x".repeat(81));
    assert.deepEqual(labels, []);
    assert.match(document.body.textContent ?? "", /at most 80 characters/);
    await type("x", "Escape");
    assert.equal(document.querySelector('input[aria-label="Repo label"]'), null);
    assert.deepEqual(labels, []);
  });

  describe("with the Secret files plugin", () => {
    let initialApp: ReturnType<typeof useAppStore.getState>;
    before(() => {
      initialApp = { ...useAppStore.getState() };
    });
    // Before each (not after): the outer afterEach unmounts after this level's hooks.
    beforeEach(() => {
      resetSecretFiles();
      useAppStore.setState(initialApp, true);
    });
    after(() => {
      resetSecretFiles();
      useAppStore.setState(initialApp, true);
    });

    const secretFilesPlugin = (enabled: boolean): PluginInfo => ({
      id: SECRET_FILES_PLUGIN_ID,
      name: "Secret files",
      description: "Keep each repo's secret files in one vault.",
      source: { label: "Orquester", url: "https://example.invalid" },
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
    const vault = (overrides: Partial<SecretVaultDetail> = {}): SecretVaultDetail => ({
      workspace: "ws",
      repoKey: KEY,
      fileCount: 1,
      clonesNeedingAttention: 0,
      newCandidates: 0,
      updatedAt: "2026-10-19T00:00:00Z",
      files: [],
      excluded: [],
      candidates: [],
      clones: [],
      ...overrides
    });
    const pill = () => document.querySelector<HTMLElement>("button[aria-expanded] [title*='Secret files']");

    it("hides its menu item and count while the plugin is off", async () => {
      useAppStore.setState({ plugins: [secretFilesPlugin(false)] });
      applySecretVault("ws", KEY, vault({ clonesNeedingAttention: 2 }));
      await render(group());
      assert.equal(pill(), null);
      await openMenu();
      assert.deepEqual(menuLabels(), ["Change icon…", "Rename label…", "Copy repo id"]);
    });

    it("offers Secret files… while the plugin is on, even before the repo has a vault", async () => {
      useAppStore.setState({ plugins: [secretFilesPlugin(true)] });
      await render(group());
      assert.equal(pill(), null);
      await openMenu();
      assert.deepEqual(menuLabels(), ["Change icon…", "Rename label…", "Copy repo id", "Secret files…"]);
    });

    it("closes Secret files… when the plugin turns off, and doesn't reopen it when it turns back on", async () => {
      useAppStore.setState({ plugins: [secretFilesPlugin(true)] });
      await render(group());
      const dialog = () => document.querySelector('[role="dialog"]');
      assert.equal(dialog(), null);
      await openMenu();
      await pick("Secret files…");
      assert.ok(dialog(), "the dialog opened");
      await act(async () => useAppStore.setState({ plugins: [secretFilesPlugin(false)] }));
      assert.equal(dialog(), null);
      await act(async () => useAppStore.setState({ plugins: [secretFilesPlugin(true)] }));
      assert.equal(dialog(), null);
    });

    it("counts clones needing attention plus new candidates, for this workspace's vault only", async () => {
      useAppStore.setState({ plugins: [secretFilesPlugin(true)] });
      applySecretVault("other", KEY, vault({ workspace: "other", clonesNeedingAttention: 5 }));
      await render(group());
      assert.equal(pill(), null);

      await act(async () => applySecretVault("ws", KEY, vault({ clonesNeedingAttention: 1, newCandidates: 2 })));
      const shown = pill();
      assert.ok(shown, "a key count");
      assert.equal(shown.textContent?.trim(), "3");
      assert.match(shown.title, /1 clone has secret files that need attention/);
      assert.match(shown.title, /2 new secret files were found/);

      await act(async () => applySecretVault("ws", KEY, vault()));
      assert.equal(pill(), null);
    });
  });
});
