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
import { BOXES_CHANGED_EVENT, type AddByoMachineRequest, type BoxProviderId, type SetBoxConnectionRequest, type SetBoxProviderCredentialsRequest } from "@orquester/api";

import { ApiError } from "../../../lib/api-client";
import { useAppStore } from "../../../store/app";
import { applyBoxesEvent, resetBoxes, setBoxesPluginOn } from "../../../lib/boxes/store";
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

const PAIR_COMMAND = "curl -fsSL https://orquester.example.com/api/boxes/pair/AbCdEfGhIjKlMnOpQrStUvWx | sh";
const PAIRING_MACHINE = box({
  id: "m1",
  purpose: "machine",
  kind: "macos",
  provider: "byo",
  providerLabel: "Your machines",
  region: "own",
  size: "machine",
  sizeLabel: "Mac mini",
  os: null,
  arch: null,
  state: "pairing",
  connected: false,
  hourlyUsd: 0,
  project: null,
  setup: [],
  byo: { name: "Mac mini", pairingExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }
});

describe("the Ephemeral AI VMs settings section", () => {
  let root: Root;
  let puts: Array<[BoxProviderId, SetBoxProviderCredentialsRequest]>;
  let deletes: string[];
  let connectionPuts: SetBoxConnectionRequest[];
  let refuse: Error | null;
  /** Tailscale on the daemon's machine, as `getBoxConnection` reports it (null: an older daemon). */
  let local: Record<string, unknown> | null = null;
  let setupAnswer: () => Promise<unknown> = async () => ({});
  let setupCalls = 0;
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
      tailscale: { configured: false, keyHint: null, tailnet: null, daemonUrl: null, policySnippet: '{"acls":[]}', ...(local ? { local } : {}) },
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
    setupBoxTailscaleServe: async () => {
      setupCalls += 1;
      return setupAnswer();
    },
    destroyBox: async (id: string) => {
      deletes.push(`box:${id}`);
      return { box: box({ id, purpose: "temporary", project: null, state: "destroying" }) };
    },
    addByoMachine: async (req: AddByoMachineRequest) => {
      byoAdds.push(req);
      return { box: PAIRING_MACHINE, command: PAIR_COMMAND, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    },
    removeByoMachine: async (id: string) => {
      deletes.push(`machine:${id}`);
      return { uninstalled: false };
    },
    updateByoMachine: async (id: string) => ({ box: { ...PAIRING_MACHINE, id } }),
    newByoPairing: async () => ({ box: PAIRING_MACHINE, command: PAIR_COMMAND, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() })
  };
  let byoAdds: AddByoMachineRequest[] = [];

  beforeEach(async () => {
    byoAdds = [];
    puts = [];
    deletes = [];
    connectionPuts = [];
    refuse = null;
    local = null;
    setupCalls = 0;
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
    assert.equal(keyInput() === null, true);
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

  describe("Tailscale on this machine", () => {
    const LOCAL = {
      installed: true,
      running: true,
      dnsName: "my-pc.tail1234.ts.net",
      tailnetIp: "100.64.0.7",
      servePort: 10000,
      serving: false,
      suggestedUrl: "https://my-pc.tail1234.ts.net:10000",
      serveCommand: "tailscale serve --bg --https=10000 http://127.0.0.1:47831"
    };
    const remount = async () => {
      act(() => root.unmount());
      resetBoxes();
      const mount = document.createElement("div");
      document.body.replaceChildren(mount);
      root = createRoot(mount);
      await act(async () => {
        root.render(createElement(BoxesPluginSection, { enabled: true }));
      });
      await settle();
      const radio = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "Tailscale");
      await click(radio);
    };
    const urlField = () => document.querySelector<HTMLInputElement>("#box-ts-daemon-url")!;

    it("shows the status line, fills the suggested URL, and sets up serving", async () => {
      local = { ...LOCAL };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      setupAnswer = async () => {
        await gate;
        return {
          mode: "tailscale",
          publicUrl: null,
          tailscale: { configured: false, daemonUrl: "https://my-pc.tail1234.ts.net:10000", policySnippet: "{}", local: { ...LOCAL, serving: true } },
          reachable: "ok",
          checkedAt: new Date().toISOString()
        };
      };
      await remount();
      assert.ok(text().includes("Tailscale on this machine: my-pc.tail1234.ts.net · not serving Orquester yet"));
      assert.ok(text().includes("Tailscale must serve Orquester there, e.g. https://my-pc.tail1234.ts.net:10000."));

      await click(buttonNamed("Use https://my-pc.tail1234.ts.net:10000"));
      assert.equal(urlField().value, "https://my-pc.tail1234.ts.net:10000");
      assert.equal(buttonNamed("Use https://my-pc.tail1234.ts.net:10000") === undefined, true, "no suggestion once the field holds it");

      await click(buttonNamed("Set up for me"));
      assert.equal(setupCalls, 1);
      assert.ok(buttonNamed("Setting up…")?.disabled, "progress while it runs");
      release();
      await settle();
      assert.ok(text().includes("Tailscale on this machine: my-pc.tail1234.ts.net · serving Orquester on :10000"));
      assert.equal(buttonNamed("Set up for me") === undefined, true, "no button once serving");
      assert.equal(urlField().value, "https://my-pc.tail1234.ts.net:10000");
      assert.ok(text().includes("Reachable"));
    });

    it("without permission, shows the daemon's message and the commands to copy", async () => {
      local = { ...LOCAL };
      setupAnswer = async () => {
        throw new ApiError(409, "POST", "/api/boxes/connection/tailscale-serve", undefined, {
          code: "BOX_TAILSCALE_NEEDS_PERMISSION",
          message: "Tailscale doesn't let this server's user (orq) change what it serves.",
          commands: ["sudo tailscale set --operator=orq", "sudo tailscale serve --bg --https=10000 http://127.0.0.1:47831"]
        });
      };
      await remount();
      await click(buttonNamed("Set up for me"));
      assert.ok(text().includes("Tailscale doesn't let this server's user (orq) change what it serves."));
      const block = [...document.querySelectorAll("pre code")].map((code) => code.textContent).find((content) => content?.includes("--operator"));
      assert.equal(block, "sudo tailscale set --operator=orq\nsudo tailscale serve --bg --https=10000 http://127.0.0.1:47831");
      assert.ok(document.querySelector('[aria-label="Copy the commands"]'));
      assert.ok(buttonNamed("Set up for me"), "can try again");
    });

    it("says when Tailscale isn't running, with nothing to set up", async () => {
      local = { ...LOCAL, running: false };
      await remount();
      assert.ok(text().includes("Tailscale isn't running on this machine."));
      assert.equal(buttonNamed("Set up for me") === undefined, true);
    });
  });

  it("Tailscale mode keeps the public URL for macOS boxes and saves it", async () => {
    const radio = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "Tailscale");
    await click(radio);
    assert.ok(text().includes("Public URL (also used by macOS boxes)"));
    const field = document.querySelector<HTMLInputElement>("#box-public-url")!;
    assert.equal(field.value, "https://orquester.example.com");
    assert.ok(document.querySelector("#box-ts-workload-id"));
    assert.ok(document.querySelector("#box-ts-workload-audience"));
    await type(document.querySelector<HTMLInputElement>("#box-ts-token")!, "tskey-api-abc");
    await type(document.querySelector<HTMLInputElement>("#box-ts-daemon-url")!, "https://pc.tail1234.ts.net:10000");
    await type(field, "https://mac.example.com");
    await click(buttonNamed("Save"));
    assert.deepEqual(connectionPuts, [
      { mode: "tailscale", tailscaleDaemonUrl: "https://pc.tail1234.ts.net:10000", publicUrl: "https://mac.example.com", tailscaleApiToken: "tskey-api-abc" }
    ]);
  });

  it("a stopped control repo step offers Retry, which re-runs the automatic steps", async () => {
    const blacksmithSaves: unknown[] = [];
    const steps = (repo: string, message: string | null) => [
      { id: "account", label: "GitHub account", state: "ok", message: null, actionUrl: null },
      { id: "org", label: "GitHub organization", state: "ok", message: null, actionUrl: null },
      { id: "app", label: "Blacksmith GitHub App", state: "ok", message: null, actionUrl: null },
      { id: "repo", label: "Control repository", state: repo, message, actionUrl: null },
      { id: "test", label: "Test run", state: "todo", message: null, actionUrl: null }
    ];
    const originals = { listBoxProviders: api.listBoxProviders, getBlacksmithSetup: api.getBlacksmithSetup };
    const message = "macOS boxes run on GitHub Actions runners outside your tailnet: set a Public URL (the runner dials it), or add a Tailscale federated identity.";
    Object.assign(api, {
      listBoxProviders: async () => ({ providers: [provider(), provider({ id: "blacksmith", label: "Blacksmith", kinds: ["macos"], status: "not-configured", keyHint: null, credentialFields: [] })] }),
      getBlacksmithSetup: async () => ({ gitAccountId: "acct", org: "Org", repo: null, steps: steps("action-needed", message) }),
      setBlacksmithSetup: async (req: unknown) => {
        blacksmithSaves.push(req);
        return { gitAccountId: "acct", org: "Org", repo: "Org/orquester-macos-boxes", steps: steps("ok", "Org/orquester-macos-boxes") };
      }
    });
    try {
      act(() => root.unmount());
      resetBoxes();
      const mount = document.createElement("div");
      document.body.replaceChildren(mount);
      root = createRoot(mount);
      await act(async () => {
        root.render(createElement(BoxesPluginSection, { enabled: true }));
      });
      await settle();
      await click(document.querySelector<HTMLButtonElement>('[aria-label="Blacksmith setup"]'));
      assert.ok(text().includes(message));
      await click(buttonNamed("Retry"));
      assert.deepEqual(blacksmithSaves, [{}]);
      assert.equal(buttonNamed("Retry") === undefined, true);
      assert.ok(text().includes("Org/orquester-macos-boxes"));
    } finally {
      Object.assign(api, originals);
    }
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

  it("Add your machine shows the one-line command and follows the pairing live, then lists the machine", async () => {
    await click(buttonNamed("Add your machine"));
    await click(buttonNamed("Create pairing command"));
    assert.equal(document.querySelector<HTMLInputElement>("#byo-machine-name")?.getAttribute("aria-invalid"), "true");
    assert.deepEqual(byoAdds, []);
    await type(document.querySelector<HTMLInputElement>("#byo-machine-name")!, "  Mac mini ");
    await click(buttonNamed("Create pairing command"));
    assert.deepEqual(byoAdds, [{ kind: "macos", name: "Mac mini" }]);
    assert.ok(text().includes(PAIR_COMMAND));
    assert.ok(document.querySelector('[aria-label="Copy the pairing command"]'));
    assert.ok(text().includes("not with sudo"));
    assert.ok(document.querySelector('[role="dialog"] [role="status"]'), "the pairing awaits the machine");

    // The machine connects: the dialog says so, and the card lists it online.
    const paired = { ...PAIRING_MACHINE, state: "ready", connected: true, os: "darwin", arch: "arm64", byo: { name: "Mac mini", pairingExpiresAt: null } };
    await act(async () => applyBoxesEvent({ type: BOXES_CHANGED_EVENT, payload: { boxes: [paired], totals: { activeCount: 0, hourlyUsd: 0, monthEstimatedUsd: 0 } } }));
    await settle();
    assert.ok(buttonNamed("Done"), "the live pairing completed");
    await click(buttonNamed("Done"));
    assert.ok(text().includes("Online"));
    assert.ok(document.querySelector('[role="switch"][aria-label="Use Mac mini for device simulators"]'));
  });

  it("a pairing can be cancelled from the dialog", async () => {
    await click(buttonNamed("Add your machine"));
    await type(document.querySelector<HTMLInputElement>("#byo-machine-name")!, "Mac mini");
    await click(buttonNamed("Create pairing command"));
    await click(buttonNamed("Cancel pairing"));
    assert.deepEqual(deletes, ["machine:m1"]);
    assert.equal(text().includes(PAIR_COMMAND), false);
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
      assert.equal(buttonNamed("Add API key") === undefined, true);
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
