/**
 * Settings → Plugins → Ephemeral AI VMs in a DOM: provider keys are entered in
 * masked fields, validated by the daemon on Save and never shown again;
 * Remove forgets them; the connection check shows its pill; temporary boxes
 * can be destroyed.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { BoxProviderId, SetBoxConnectionRequest, SetBoxProviderCredentialsRequest } from "@orquester/api";

import { ApiError } from "../../../lib/api-client";
import { useAppStore } from "../../../store/app";
import { resetBoxes, setBoxesPluginOn } from "../../../lib/boxes/store";
import { box, kind, provider } from "../../../lib/boxes/fixtures.test-helpers";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let BoxesPluginSection: typeof import("./BoxesPluginSection").BoxesPluginSection;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
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
  ({ BoxesPluginSection } = await import("./BoxesPluginSection"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const VULTR = provider({
  id: "vultr",
  label: "Vultr",
  kinds: ["linux", "windows"],
  status: "not-configured",
  keyHint: null,
  accountNote: null,
  credentialsUrl: "https://my.vultr.com/settings/#settingsapi",
  credentialFields: [{ id: "key", label: "API key", secret: true }],
  windowsImage: { state: "none", message: null, updatedAt: null }
});

describe("the Ephemeral AI VMs settings section", () => {
  let root: Root;
  let puts: Array<[BoxProviderId, SetBoxProviderCredentialsRequest]>;
  let deletes: string[];
  let connectionPuts: SetBoxConnectionRequest[];
  let refuse: Error | null;
  const initial = { ...useAppStore.getState() };

  const api = {
    connection: { id: "c1" },
    listBoxes: async () => ({
      boxes: [box(), box({ id: "t1", purpose: "temporary", project: null, purposeNote: "build on macOS", kind: "macos", providerLabel: "Blacksmith" })],
      totals: { activeCount: 2, hourlyUsd: 4.8119, monthEstimatedUsd: 12.5 }
    }),
    listBoxProviders: async () => ({ providers: [provider(), VULTR] }),
    listBoxKinds: async () => ({ kinds: [kind()] }),
    listBoxConfigChanges: async () => ({ changes: [] }),
    getBoxConnection: async () => ({
      mode: "public-url",
      publicUrl: "https://orquester.example.com",
      tailscale: { configured: false, keyHint: null, tailnet: null, daemonUrl: null, policySnippet: '{"acls":[]}' },
      reachable: "unknown",
      reachableMessage: null,
      checkedAt: null
    }),
    getBlacksmithSetup: async () => ({ gitAccountId: null, org: null, repo: null, steps: [] }),
    setBoxProviderCredentials: async (id: BoxProviderId, req: SetBoxProviderCredentialsRequest) => {
      puts.push([id, req]);
      if (refuse) throw refuse;
      return { ...VULTR, status: "connected", keyHint: "wxyz" };
    },
    removeBoxProviderCredentials: async (id: BoxProviderId) => {
      deletes.push(`provider:${id}`);
      return { ...provider(), status: "not-configured", keyHint: null };
    },
    setBoxConnection: async (req: SetBoxConnectionRequest) => {
      connectionPuts.push(req);
      return { mode: "public-url", publicUrl: req.publicUrl ?? null, tailscale: {}, reachable: "unknown" };
    },
    testBoxConnection: async () => ({
      mode: "public-url",
      publicUrl: "https://orquester.example.com",
      tailscale: {},
      reachable: "ok",
      checkedAt: new Date().toISOString()
    }),
    destroyBox: async (id: string) => {
      deletes.push(`box:${id}`);
      return { box: box({ id, purpose: "temporary", project: null, state: "destroying" }) };
    }
  };

  beforeEach(async () => {
    puts = [];
    deletes = [];
    connectionPuts = [];
    refuse = null;
    resetBoxes();
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
    useAppStore.setState({ api: api as never, connectionStatus: "connected", accounts: [] } as never);
    await act(async () => {
      root.render(createElement(BoxesPluginSection, { enabled: true }));
    });
    await settle();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetBoxes();
  });

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        for (let j = 0; j < 10; j += 1) await Promise.resolve();
      });
    }
  };
  const text = () => document.body.textContent ?? "";
  const buttonNamed = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
  const click = async (el: HTMLElement | null | undefined) => {
    assert.ok(el, "element present");
    await act(async () => el.click());
    await settle();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const keyInput = () => document.querySelector<HTMLInputElement>("#box-provider-vultr-key");

  it("shows the totals, each provider's status and the Windows image row", () => {
    assert.ok(text().includes("2 boxes running · $4.81/h · $12.50 this month"));
    assert.ok(text().includes("Key …a1b2 · Linux VM · New accounts need an ID check."));
    assert.ok(text().includes("Connected"));
    assert.ok(buttonNamed("Add API key"));
    assert.ok(text().includes("Windows imageNot prepared"));
    // Not connected: nothing to prepare the image with yet.
    assert.equal(buttonNamed("Prepare Windows image"), undefined);
  });

  it("asks for the key in a masked field, refuses an empty one, and saves through the daemon", async () => {
    await click(buttonNamed("Add API key"));
    const input = keyInput();
    assert.equal(input?.type, "password");
    assert.equal(input?.value, "");
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("Get a key"));
    assert.equal(link?.getAttribute("href"), "https://my.vultr.com/settings/#settingsapi");

    await click(buttonNamed("Save"));
    assert.ok(text().includes("Enter the API key."));
    assert.deepEqual(puts, []);

    await type(keyInput()!, "  VULTR-SECRET-KEY  ");
    await click(buttonNamed("Save"));
    assert.deepEqual(puts, [["vultr", { credentials: { key: "VULTR-SECRET-KEY" } }]]);
    // The form closed; the row shows the new state; the key is nowhere in the page.
    assert.equal(keyInput(), null);
    assert.ok(text().includes("Key …wxyz"));
    assert.equal(document.body.innerHTML.includes("VULTR-SECRET-KEY"), false);
    // Reopened, the field starts empty again.
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Vultr credentials"]'));
    assert.equal(keyInput()?.value, "");
  });

  it("shows the daemon's reason when the provider refuses the key", async () => {
    refuse = new ApiError(400, "PUT", "/api/boxes/providers/vultr", undefined, {
      code: "BOX_PROVIDER_ERROR",
      message: "Vultr says: invalid API key"
    });
    await click(buttonNamed("Add API key"));
    await type(keyInput()!, "nope");
    await click(buttonNamed("Save"));
    assert.ok(text().includes("Vultr says: invalid API key"));
    assert.ok(keyInput(), "the form stays open");
  });

  it("Remove asks first, then forgets the credentials", async () => {
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Hetzner credentials"]'));
    await click(buttonNamed("Remove"));
    assert.ok(text().includes("Remove the Hetzner credentials?"));
    assert.deepEqual(deletes, []);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Remove").pop();
    await click(confirm);
    assert.deepEqual(deletes, ["provider:hetzner"]);
    assert.ok(text().includes("Add API key"));
  });

  it("the connection check shows reachability; Save sends only what changed", async () => {
    assert.ok(text().includes("Not checked"));
    await click(buttonNamed("Check"));
    assert.ok(text().includes("Reachable"));

    await type(document.querySelector<HTMLInputElement>("#box-public-url")!, "http://insecure.example.com");
    await click(buttonNamed("Save"));
    assert.ok(text().includes("The public URL must start with https://."));
    assert.deepEqual(connectionPuts, []);
    await type(document.querySelector<HTMLInputElement>("#box-public-url")!, "https://new.example.com");
    await click(buttonNamed("Save"));
    assert.deepEqual(connectionPuts, [{ publicUrl: "https://new.example.com" }]);
  });

  it("Tailscale mode shows the policy snippet to copy", async () => {
    const tailscale = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "Tailscale");
    await click(tailscale);
    assert.equal(document.querySelector<HTMLInputElement>("#box-ts-token")?.type, "password");
    assert.ok(text().includes('{"acls":[]}'));
    assert.ok(document.querySelector('[aria-label="Copy the policy snippet"]'));
  });

  it("marks every secret field new-password so Chrome does not fill a saved login into the page", async () => {
    // Chrome ignores autocomplete="off" on a password field and fills the saved
    // username into the nearest text field before it: the plugin search box.
    const radio = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label);
    const secretAutocomplete = () =>
      [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].map((i) => [i.id, i.getAttribute("autocomplete")]);

    await click(buttonNamed("Add API key"));
    await click(radio("Tailscale"));
    assert.deepEqual(secretAutocomplete(), [
      ["box-provider-vultr-key", "new-password"],
      ["box-ts-token", "new-password"]
    ]);
    await click(radio("OAuth client"));
    assert.deepEqual(secretAutocomplete(), [
      ["box-provider-vultr-key", "new-password"],
      ["box-ts-client-secret", "new-password"]
    ]);
  });

  it("lists the boxes and destroys a temporary one after confirming", async () => {
    assert.ok(text().includes("jaspersito / JasperEngine"));
    assert.ok(text().includes("Agent chat: build on macOS"));
    // Only the temporary box offers Destroy.
    const destroyButtons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Destroy");
    assert.equal(destroyButtons.length, 1);
    await click(destroyButtons[0]);
    assert.ok(text().includes("Destroy this box?"));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Destroy").pop();
    await click(confirm);
    assert.deepEqual(deletes, ["box:t1"]);
    assert.ok(text().includes("Destroying…"));
  });

  describe("with the plugin off", () => {
    const original = api.listBoxes;
    const render = async (boxes: unknown[]) => {
      (api as { listBoxes: unknown }).listBoxes = async () => ({
        boxes,
        totals: { activeCount: boxes.length, hourlyUsd: 1, monthEstimatedUsd: 1 }
      });
      act(() => root.unmount());
      resetBoxes();
      setBoxesPluginOn(false);
      const mount = document.createElement("div");
      document.body.replaceChildren(mount);
      root = createRoot(mount);
      await act(async () => {
        root.render(createElement(BoxesPluginSection, { enabled: false }));
      });
      await settle();
    };

    afterEach(() => {
      api.listBoxes = original;
      setBoxesPluginOn(true);
    });

    it("still lists the boxes that are running, with a notice, and destroys a temporary one", async () => {
      await render([
        box(),
        box({ id: "t1", purpose: "temporary", project: null, purposeNote: "build on macOS", kind: "macos", providerLabel: "Blacksmith" }),
        box({ id: "old", purpose: "temporary", project: null, purposeNote: "long gone", state: "destroyed", destroyedAt: new Date().toISOString() })
      ]);
      assert.ok(text().includes("Ephemeral AI VMs is off, but these boxes are still running and billing."));
      assert.ok(text().includes("jaspersito / JasperEngine"));
      assert.ok(text().includes("Agent chat: build on macOS"));
      assert.equal(text().includes("long gone"), false);
      // Nothing of the plugin's setup while it is off.
      assert.equal(buttonNamed("Add API key"), undefined);
      const destroyButtons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Destroy");
      assert.equal(destroyButtons.length, 1);
      await click(destroyButtons[0]);
      const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Destroy").pop();
      await click(confirm);
      assert.deepEqual(deletes, ["box:t1"]);
      assert.ok(text().includes("Destroying…"));
    });

    it("shows no notice when nothing is running", async () => {
      await render([box({ state: "destroyed", destroyedAt: new Date().toISOString() })]);
      assert.equal(text().includes("still running and billing"), false);
      assert.equal(text().includes("JasperEngine"), false);
    });
  });
});
