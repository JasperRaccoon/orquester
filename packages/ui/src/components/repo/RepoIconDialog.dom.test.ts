/**
 * The repo icon dialog in a DOM (spec 2026-10-18 §3): the emoji field is
 * validated before anything is sent, a website failure shows the daemon's
 * refusal in friendly words, and closing mid-request drops only the dialog's
 * feedback — the store still takes the answer.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { RepoIdentityResponse } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let RepoIconDialog: typeof import("./RepoIconDialog").RepoIconDialog;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let store: typeof import("../../lib/repo-identities/store");

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
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
  ({ RepoIconDialog } = await import("./RepoIconDialog"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  store = await import("../../lib/repo-identities/store");
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

interface Pending {
  name: string;
  args: unknown[];
  resolve: (value: RepoIdentityResponse) => void;
  reject: (error: unknown) => void;
  promise: Promise<RepoIdentityResponse>;
}

function fakeApi() {
  const calls: Pending[] = [];
  const call = (name: string) => (...args: unknown[]) => {
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<RepoIdentityResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({ name, args, resolve, reject, promise });
    return promise;
  };
  const api = {
    connection: { id: "c1" },
    setRepoEmoji: call("setRepoEmoji"),
    fetchRepoFavicon: call("fetchRepoFavicon"),
    clearRepoIcon: call("clearRepoIcon"),
    uploadRepoIcon: call("uploadRepoIcon"),
    readRepoIcon: () => new Promise<ArrayBuffer>(() => undefined)
  };
  return { api: api as unknown as ApiClient, calls };
}

describe("repo icon dialog", () => {
  let root: Root;
  let closes: number;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    // The modal hands focus back on a timer after it closes: run it inside the test.
    mock.timers.enable({ apis: ["setTimeout"] });
    store.resetRepoIdentities();
    closes = 0;
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
          children: createElement(RepoIconDialog, {
            open,
            repoKey: KEY,
            repoLabel: "JasperRaccoon/JasperEngine",
            onClose: () => (closes += 1)
          })
        })
      );
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

  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

  const click = async (element: Element | undefined) => {
    assert.ok(element);
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  it("titles itself with the repo and refuses more than one emoji", async () => {
    await render();
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /JasperRaccoon\/JasperEngine/);
    await type("Emoji", "🦝🦝");
    await click(button("Use emoji"));
    assert.equal(api.calls.length, 0);
    assert.ok(document.querySelector('[role="alert"]')?.textContent);
  });

  it("sets an emoji, applies it and closes", async () => {
    await render();
    await type("Emoji", " 🦝 ");
    await click(button("Use emoji"));
    assert.deepEqual(api.calls[0].args, [{ repoKey: KEY, emoji: "🦝" }]);
    await act(async () => {
      api.calls[0].resolve({ identity: { repoKey: KEY, icon: { kind: "emoji", value: "🦝" }, updatedAt: "2026-10-18T10:00:00.000Z" } });
      await api.calls[0].promise;
    });
    assert.deepEqual(store.repoIdentitiesStore.getState().identities.get(KEY)?.icon, { kind: "emoji", value: "🦝" });
    assert.equal(closes, 1);
  });

  it("shows a website failure inline in friendly words", async () => {
    await render();
    await click(Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === "Website"));
    await type("Website domain", "https://matssmile.com/about");
    await click(button("Fetch icon"));
    assert.equal(button("Fetch icon")?.disabled, true);
    await act(async () => {
      api.calls[0].reject(Object.assign(new Error("failed"), { status: 502, body: { code: "FAVICON_UNREACHABLE" }, serverMessage: null }));
      await api.calls[0].promise.catch(() => undefined);
    });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /matssmile\.com/);
    assert.equal(button("Fetch icon")?.disabled, false);
  });

  it("closed mid-request, still applies the late answer to the store", async () => {
    await render();
    await click(Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === "Website"));
    await type("Website domain", "matssmile.com");
    await click(button("Fetch icon"));
    await render(false);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const icon = { kind: "image" as const, contentType: "image/png" as const, version: "v1", source: { kind: "favicon" as const, domain: "matssmile.com" } };
    await act(async () => {
      api.calls[0].resolve({ identity: { repoKey: KEY, icon, updatedAt: "2026-10-18T10:00:00.000Z" } });
      await api.calls[0].promise;
    });
    assert.deepEqual(store.repoIdentitiesStore.getState().identities.get(KEY)?.icon, icon);
  });
});
