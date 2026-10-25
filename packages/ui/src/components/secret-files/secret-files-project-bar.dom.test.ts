/**
 * The secret-files project bar and compare modal in a DOM (spec §7): the bar
 * shows the open project's drift with the compare summary, Push asks first
 * naming the clones it overwrites, a dismissal holds until something changes
 * (a further edit included), Push / Reset send the content tokens shown and a
 * CONTENT_CHANGED refusal asks to review again, files it can't get show an
 * informational variant, and Compare lists variable names only.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  SECRET_FILES_PLUGIN_ID,
  type PluginInfo,
  type SecretFileCloneState,
  type SecretFileCompare,
  type SecretFilesCloneRequest,
  type SecretVaultDetail
} from "@orquester/api";

import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
import { applySecretVault, resetSecretFiles } from "../../lib/secret-files/store";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SecretFilesProjectBar: typeof import("./SecretFilesProjectBar").SecretFilesProjectBar;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
  "localStorage",
  "sessionStorage"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let initialApp: ReturnType<typeof import("../../store/app").useAppStore.getState>;

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
  ({ SecretFilesProjectBar } = await import("./SecretFilesProjectBar"));
  ({ useAppStore } = await import("../../store/app"));
  initialApp = { ...useAppStore.getState() };
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const KEY = "github.com/o/matssmile";
let projectCase = 0;
let MINE: string;

const plugin = (enabled: boolean): PluginInfo => ({
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

const vault = (mine: SecretFileCloneState[], version = "v1"): SecretVaultDetail => ({
  workspace: "ws",
  repoKey: KEY,
  fileCount: 2,
  clonesNeedingAttention: 1,
  newCandidates: 0,
  updatedAt: "2026-10-19T00:00:00Z",
  files: [
    { path: "MatsSmileBack/.env", version, updatedAt: "2026-10-19T00:00:00Z", updatedBy: { kind: "user" } },
    { path: "web/.env", version: "w1", updatedAt: "2026-10-19T00:00:00Z", updatedBy: { kind: "user" } }
  ],
  excluded: [],
  candidates: [],
  clones: [
    { projectPath: MINE, projectName: "MatsSmile", files: mine, needsAttention: true },
    {
      projectPath: "/w/ws/MatsSmile2",
      projectName: "MatsSmile2",
      files: [{ path: "MatsSmileBack/.env", state: "synced" }],
      needsAttention: false
    },
    {
      projectPath: "/w/ws/MatsSmile3",
      projectName: "MatsSmile3",
      files: [{ path: "MatsSmileBack/.env", state: "modified" }],
      needsAttention: true
    }
  ]
});

const ENV_COMPARE: SecretFileCompare = {
  format: "env",
  keys: [
    { key: "PRIVATEPROXY_API_KEY", change: "removed" },
    { key: "DB_URL", change: "changed" },
    { key: "NEW_FLAG", change: "added" },
    { key: "PORT", change: "same" },
    { key: "HOST", change: "same" }
  ]
};

describe("the secret-files project bar", () => {
  let root: Root;
  let compares: string[];
  let pushes: SecretFilesCloneRequest[];
  let resets: SecretFilesCloneRequest[];
  let fetches: number;
  /** The token the next compare answers with (the copy the daemon compared). */
  let comparedToken: string | undefined;
  /** Set: Push / Reset answer 409 CONTENT_CHANGED and a refetch answers this vault. */
  let changedTo: SecretVaultDetail | null;

  const contentChanged = () =>
    Object.assign(new Error("changed"), {
      status: 409,
      body: { code: "CONTENT_CHANGED", message: "A file's content no longer matches." }
    });

  const fakeApi = {
    compareSecretFile: async (_ws: string, _repo: string, _project: string, path: string) => {
      compares.push(path);
      return { path, compare: ENV_COMPARE, ...(comparedToken ? { contentToken: comparedToken } : {}) };
    },
    pushSecretFiles: async (req: SecretFilesCloneRequest) => {
      pushes.push(req);
      if (changedTo) throw contentChanged();
      return { vault: vault([{ path: "MatsSmileBack/.env", state: "synced" }], "v2") };
    },
    resetSecretFiles: async (req: SecretFilesCloneRequest) => {
      resets.push(req);
      if (changedTo) throw contentChanged();
      return { vault: vault([{ path: "MatsSmileBack/.env", state: "synced" }]) };
    },
    getSecretVault: async () => {
      fetches += 1;
      if (!changedTo) throw new Error("unexpected fetch");
      return { vault: changedTo };
    }
  } as unknown as ApiClient;

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await act(async () => undefined);
  };

  const render = async () => {
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: fakeApi,
          useTitlebar: false,
          children: createElement(SecretFilesProjectBar)
        })
      );
    });
    await flush();
  };

  const bar = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Secret files"]');
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  const click = async (element: HTMLElement | undefined | null) => {
    assert.ok(element, "the element exists");
    await act(async () => element.click());
    await flush();
  };

  beforeEach(() => {
    compares = [];
    pushes = [];
    resets = [];
    fetches = 0;
    comparedToken = undefined;
    changedTo = null;
    resetSecretFiles();
    MINE = `/w/ws/MatsSmile-${++projectCase}`;
    useAppStore.setState(
      {
        ...initialApp,
        plugins: [plugin(true)],
        currentProject: { name: "MatsSmile", workspace: "ws", path: MINE, repoKey: KEY, repoName: "o/MatsSmile" }
      },
      true
    );
    // A closing modal hands focus back on a setTimeout; run it before the DOM goes.
    mock.timers.enable({ apis: ["setTimeout"] });
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    resetSecretFiles();
    useAppStore.setState(initialApp, true);
  });

  it("stays hidden while the plugin is off or the project is in sync", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "synced" }]));
    await render();
    assert.equal(bar(), null);

    await act(async () => applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }])));
    await flush();
    assert.ok(bar());

    await act(async () => useAppStore.setState({ plugins: [plugin(false)] }));
    assert.equal(bar(), null);
  });

  it("says how the one modified file differs, and Push asks first naming the clones it overwrites", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }]));
    await render();
    assert.deepEqual(compares, ["MatsSmileBack/.env"]);
    assert.equal(bar()?.textContent?.includes("MatsSmileBack/.env differs from the vault: 1 added, 1 removed, 1 changed"), true);
    assert.ok(button("Reset to vault"));
    assert.ok(button("Compare"));

    await click(button("Push to vault"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog?.textContent ?? "", /overwrites the copy in MatsSmile2\./);
    assert.match(dialog?.textContent ?? "", /MatsSmile3 has its own changes and stays flagged/);
    assert.equal(pushes.length, 0);

    const confirm = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Push to vault"
    );
    await click(confirm);
    assert.deepEqual(pushes, [{ workspace: "ws", repoKey: KEY, projectPath: MINE, files: ["MatsSmileBack/.env"] }]);
    // The answered vault has this clone in sync: the bar goes.
    assert.equal(bar(), null);
  });

  it("stays dismissed until a flagged file's state or vault version changes", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }]));
    await render();
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'));
    assert.equal(bar(), null);

    // Same states and versions: still dismissed.
    await act(async () => applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }])));
    await flush();
    assert.equal(bar(), null);

    // Another clone pushed: the vault version moved, so it shows again.
    await act(async () => applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }], "v3")));
    await flush();
    assert.ok(bar());
  });

  it("a further edit of the flagged file refreshes the counts and brings a dismissed bar back", async () => {
    const edited = (token: string) => vault([{ path: "MatsSmileBack/.env", state: "modified", contentToken: token }]);
    applySecretVault("ws", KEY, edited("t1"));
    await render();
    assert.equal(compares.length, 1);

    // Edited again (still `modified`, same vault version): the counts are fetched again.
    await act(async () => applySecretVault("ws", KEY, edited("t2")));
    await flush();
    assert.equal(compares.length, 2);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'));
    assert.equal(bar(), null);
    await act(async () => applySecretVault("ws", KEY, edited("t3")));
    await flush();
    assert.ok(bar(), "the dismissed bar is back");
    assert.equal(compares.length, 3);
  });

  it("a dismissal survives a daemon restart (new tokens), and a further edit after it still brings the bar back", async () => {
    const at = (token: string, boot: string, seq: number) => ({
      ...vault([{ path: "MatsSmileBack/.env", state: "modified", contentToken: token }]),
      revision: { boot, seq }
    });
    applySecretVault("ws", KEY, at("t1", "b1", 1));
    await render();
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'));
    assert.equal(bar(), null);

    // The daemon restarted: the same copy has another token under the new boot.
    await act(async () => applySecretVault("ws", KEY, at("r1", "b2", 1)));
    await flush();
    assert.equal(bar(), null, "still dismissed");

    // Edited after the restart: back.
    await act(async () => applySecretVault("ws", KEY, at("r2", "b2", 2)));
    await flush();
    assert.ok(bar(), "the dismissed bar is back");
  });

  const confirmButton = (label: string) =>
    [...(document.querySelector('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === label
    );

  it("Push and Reset send the content tokens the bar showed", async () => {
    comparedToken = "t1";
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified", contentToken: "t1" }]));
    await render();
    await click(button("Push to vault"));
    await click(confirmButton("Push to vault"));
    assert.deepEqual(pushes, [
      {
        workspace: "ws",
        repoKey: KEY,
        projectPath: MINE,
        files: ["MatsSmileBack/.env"],
        expect: { "MatsSmileBack/.env": "t1" }
      }
    ]);

    await act(async () =>
      applySecretVault(
        "ws",
        KEY,
        vault([
          { path: "MatsSmileBack/.env", state: "modified", contentToken: "t5" },
          { path: "web/.env", state: "deleted" }
        ])
      )
    );
    await flush();
    await click(button("Reset to vault"));
    await click(confirmButton("Reset to vault"));
    assert.deepEqual(resets, [
      {
        workspace: "ws",
        repoKey: KEY,
        projectPath: MINE,
        files: ["MatsSmileBack/.env", "web/.env"],
        expect: { "MatsSmileBack/.env": "t5", "web/.env": null }
      }
    ]);
  });

  it("a push refused because the file changed says so and refreshes the vault", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified", contentToken: "t1" }]));
    await render();
    changedTo = vault([{ path: "MatsSmileBack/.env", state: "modified", contentToken: "t2" }]);
    await click(button("Push to vault"));
    await click(confirmButton("Push to vault"));
    assert.equal(pushes.length, 1);
    assert.equal(fetches, 1);
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      "This file changed since you looked \u2014 review it again."
    );
    // The refreshed copy is the one shown (and compared) now.
    assert.equal(compares.length, 2);
  });

  it("counts several files, without Push when only deletions are flagged", async () => {
    applySecretVault(
      "ws",
      KEY,
      vault([
        { path: "MatsSmileBack/.env", state: "deleted" },
        { path: "web/.env", state: "deleted" }
      ])
    );
    await render();
    assert.deepEqual(compares, []);
    assert.match(bar()?.textContent ?? "", /2 secret files differ from the vault/);
    assert.equal(button("Push to vault"), undefined);
    assert.ok(button("Reset to vault"));
  });

  it("shows an informational variant for a file whose folder is missing", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "missing-dir" }]));
    await render();
    assert.match(bar()?.textContent ?? "", /MatsSmileBack\/\.env can't be copied here: its folder doesn't exist/);
    assert.ok(button("Open secret files…"));
    assert.equal(button("Push to vault"), undefined);
    assert.equal(button("Reset to vault"), undefined);
  });

  it("Compare lists variable names with their change, never values", async () => {
    applySecretVault("ws", KEY, vault([{ path: "MatsSmileBack/.env", state: "modified" }]));
    await render();
    await click(button("Compare"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the compare modal");
    const rows = [...dialog.querySelectorAll('[aria-label="Variables that differ"] li')].map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim()
    );
    assert.deepEqual(rows, ["PRIVATEPROXY_API_KEYremoved", "DB_URLchanged", "NEW_FLAGadded"]);
    assert.match(dialog.textContent ?? "", /2 variables are the same/);
    assert.match(dialog.textContent ?? "", /To see values, open the file/);
    assert.ok(
      [...dialog.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Open file"),
      "the open project's file can be opened"
    );
  });
});
