/**
 * The "Secret files…" dialog in a DOM (spec §6): with no vault it scans,
 * pre-ticks conventional candidates, offers a source per differing file with
 * a value-class table (never values), validates hand-added paths, and sets up;
 * once the vault exists it shows every clone's states with confirmed Push.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SecretFileCandidatesResponse, SecretVaultDetail } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SecretFilesDialog: typeof import("./SecretFilesDialog").SecretFilesDialog;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let store: typeof import("../../lib/secret-files/store");

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "Event"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
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
  ({ SecretFilesDialog } = await import("./SecretFilesDialog"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  store = await import("../../lib/secret-files/store");
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const WS = "jaspersito";
const KEY = "github.com/jasperraccoon/matssmile";
const A = "/ws/jaspersito/MatsSmile";
const B = "/ws/jaspersito/MatsSmile2";
const C = "/ws/jaspersito/MatsSmile3";

const SCAN: SecretFileCandidatesResponse = {
  workspace: WS,
  repoKey: KEY,
  clones: [
    { projectPath: A, projectName: "MatsSmile" },
    { projectPath: B, projectName: "MatsSmile2" },
    { projectPath: C, projectName: "MatsSmile3" }
  ],
  candidates: [
    {
      path: "MatsSmileBack/.env",
      conventional: true,
      managed: false,
      excluded: false,
      format: "env",
      variants: [
        { variantId: "v-old", projectPaths: [B], modifiedAt: "2026-10-01T10:00:00.000Z", keyCount: 3 },
        { variantId: "v-new", projectPaths: [A], modifiedAt: "2026-10-18T10:00:00.000Z", keyCount: 2 }
      ],
      defaultVariantId: "v-new",
      keys: [
        { key: "DATABASE_URL", byVariant: { "v-old": 3, "v-new": 3 } },
        { key: "PRIVATEPROXY_API_KEY", byVariant: { "v-old": 1, "v-new": null } }
      ],
      refused: []
    },
    {
      path: "MatsSmileBack/.env.local",
      conventional: true,
      managed: false,
      excluded: false,
      format: "env",
      variants: [{ variantId: "v-local", projectPaths: [A], modifiedAt: "2026-10-18T10:00:00.000Z", keyCount: 1 }],
      defaultVariantId: "v-local",
      refused: [{ projectPath: C, refusal: "tracked" }]
    }
  ]
};

const VAULT: SecretVaultDetail = {
  workspace: WS,
  repoKey: KEY,
  fileCount: 1,
  clonesNeedingAttention: 1,
  newCandidates: 0,
  updatedAt: "2026-10-19T10:00:00.000Z",
  files: [{ path: "MatsSmileBack/.env", version: "v1", updatedAt: "2026-10-19T10:00:00.000Z", updatedBy: { kind: "user" } }],
  excluded: ["MatsSmileBack/.env.local"],
  candidates: [],
  clones: [
    { projectPath: A, projectName: "MatsSmile", files: [{ path: "MatsSmileBack/.env", state: "synced" }], needsAttention: false },
    { projectPath: B, projectName: "MatsSmile2", files: [{ path: "MatsSmileBack/.env", state: "modified" }], needsAttention: true },
    { projectPath: C, projectName: "MatsSmile3", files: [{ path: "MatsSmileBack/.env", state: "missing-dir" }], needsAttention: true }
  ]
};

interface Pending {
  name: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  promise: Promise<unknown>;
}

function fakeApi() {
  const calls: Pending[] = [];
  const call = (name: string) => (...args: unknown[]) => {
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({ name, args, resolve, reject, promise });
    return promise;
  };
  const api = {
    connection: { id: "c1" },
    listSecretVaults: call("list"),
    getSecretVault: call("get"),
    deleteSecretVault: call("delete"),
    scanSecretFileCandidates: call("scan"),
    setupSecretVault: call("setup"),
    updateSecretFiles: call("update"),
    pushSecretFiles: call("push"),
    resetSecretFiles: call("reset"),
    compareSecretFile: call("compare")
  };
  const last = (name: string) => [...calls].reverse().find((entry) => entry.name === name)!;
  return { api: api as unknown as ApiClient, calls, last };
}

const notFound = () => Object.assign(new Error("not found"), { status: 404, body: { code: "VAULT_NOT_FOUND" } });

describe("secret files dialog", () => {
  let root: Root;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    store.resetSecretFiles();
    api = fakeApi();
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
  });

  const render = async (open = true) => {
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: api.api,
          useTitlebar: false,
          children: createElement(SecretFilesDialog, {
            open,
            workspace: WS,
            repoKey: KEY,
            repoLabel: "JasperRaccoon/MatsSmile",
            onClose: () => undefined
          })
        })
      );
    });
  };

  const settle = async (name: string, value: unknown, fail = false) => {
    const pending = api.last(name);
    await act(async () => {
      if (fail) pending.reject(value);
      else pending.resolve(value);
      await pending.promise.catch(() => undefined);
    });
  };

  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  const checkbox = (label: string) => document.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`);
  const radios = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const text = () => document.body.textContent ?? "";

  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => {
      (element as HTMLElement).click();
    });
  };

  const type = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  const openSetup = async () => {
    await render();
    assert.match(text(), /Loading/);
    await settle("get", notFound(), true);
    assert.equal(api.last("scan").args[2], undefined);
    await settle("scan", SCAN);
  };

  it("sets up: conventional files ticked, newest copy pre-selected, merge with a primary, unticked ones excluded", async () => {
    await openSetup();
    assert.equal(checkbox("MatsSmileBack/.env")?.checked, true);
    assert.equal(checkbox("MatsSmileBack/.env.local")?.checked, true);
    assert.match(text(), /Not synced in MatsSmile3: tracked by git/);

    // Source picker: two copies, the newest (Copy 2, MatsSmile) checked, plus Merge all.
    const [oldCopy, newCopy, merge] = radios();
    assert.equal(radios().length, 3);
    assert.equal(oldCopy.checked, false);
    assert.equal(newCopy.checked, true);
    assert.match(text(), /newest/);
    // The variable table: letters and dashes only.
    const rows = Array.from(document.querySelectorAll("tbody tr")).map((row) => row.textContent);
    assert.deepEqual(rows, ["DATABASE_URLAA", "PRIVATEPROXY_API_KEYA—"]);

    await click(merge);
    const primary = document.querySelector<HTMLSelectElement>('select[aria-label="Merge primary for MatsSmileBack/.env"]');
    assert.equal(primary?.value, A);
    await click(checkbox("MatsSmileBack/.env.local"));
    await click(button("Set up"));
    assert.deepEqual(api.last("setup").args[0], {
      workspace: WS,
      repoKey: KEY,
      files: [{ path: "MatsSmileBack/.env", source: { merge: true, primary: A } }],
      excluded: ["MatsSmileBack/.env.local"]
    });
    assert.equal(button("Set up")?.disabled, true);

    await settle("setup", { vault: VAULT });
    assert.ok(store.getSecretVault(WS, KEY));
    assert.match(text(), /Files in the vault/);
    assert.match(text(), /Changed/);
    assert.match(text(), /Missing folder/);
  });

  it("validates a hand-added path before scanning it, then adds it ticked", async () => {
    await openSetup();
    await type("Add file", "../secrets.conf");
    await click(button("Add"));
    assert.equal(api.calls.filter((entry) => entry.name === "scan").length, 1);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /'\.\.'/);

    await type("Add file", "deploy/targets.conf");
    await click(button("Add"));
    assert.equal(api.last("scan").args[2], "deploy/targets.conf");
    await settle("scan", {
      workspace: WS,
      repoKey: KEY,
      clones: SCAN.clones,
      candidates: [
        {
          path: "deploy/targets.conf",
          conventional: false,
          managed: false,
          excluded: false,
          format: "lines",
          variants: [{ variantId: "t", projectPaths: [B], modifiedAt: "2026-10-10T10:00:00.000Z", lineCount: 4 }],
          defaultVariantId: "t",
          refused: []
        }
      ]
    });
    assert.equal(checkbox("deploy/targets.conf")?.checked, true);
  });

  it("shows a daemon refusal inline and keeps the dialog usable", async () => {
    await openSetup();
    await click(button("Set up"));
    await settle(
      "setup",
      Object.assign(new Error("x"), { status: 409, serverMessage: "MatsSmile2's copy is tracked by git." }),
      true
    );
    assert.equal(document.querySelector('[role="alert"]')?.textContent, "MatsSmile2's copy is tracked by git.");
    assert.equal(button("Set up")?.disabled, false);
  });

  it("closed mid-setup, still applies the late answer to the store", async () => {
    await openSetup();
    await click(button("Set up"));
    await render(false);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await settle("setup", { vault: VAULT });
    assert.ok(store.getSecretVault(WS, KEY));
  });

  it("manages: push asks first, naming the clones that will be overwritten", async () => {
    store.applySecretVault(WS, KEY, VAULT);
    await render();
    assert.match(text(), /Files in the vault/);
    assert.equal(button("Reset to vault") !== undefined, true);
    await click(button("Push to vault"));
    assert.match(text(), /Push MatsSmile2 to the vault\?/);
    assert.match(text(), /MatsSmile will be overwritten with it\./);
    assert.equal(api.calls.some((entry) => entry.name === "push"), false);
    const confirm = Array.from(document.querySelectorAll('[role="dialog"]')).pop()!;
    await click(Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Push to vault"));
    assert.deepEqual(api.last("push").args[0], {
      workspace: WS,
      repoKey: KEY,
      projectPath: B,
      files: ["MatsSmileBack/.env"]
    });
  });
});
