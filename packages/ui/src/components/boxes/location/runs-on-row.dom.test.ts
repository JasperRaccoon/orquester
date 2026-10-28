/**
 * The New project dialog's "Runs on" row (Ephemeral AI VMs spec §8.1): shown
 * only while the plugin is on, a box choice loads its offers, and every tab
 * submits its usual request plus the box `location` through the server-side
 * create — the typed `git clone` path included.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { BoxKind, BoxProviderId, CreateProjectRequest, PluginInfo } from "@orquester/api";

import { useAppStore } from "../../../store/app";
import { resetBoxes } from "../../../lib/boxes/store";
import { box, change, kind, offers, provider } from "../../../lib/boxes/fixtures.test-helpers";
import type { NewProjectPreset } from "../../sidebar/NewProjectModal";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let NewProjectModal: typeof import("../../sidebar/NewProjectModal").NewProjectModal;

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
  ({ NewProjectModal } = await import("../../sidebar/NewProjectModal"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const plugin = (enabled: boolean): PluginInfo => ({
  id: "ephemeral-vms",
  name: "Ephemeral AI VMs",
  description: "",
  source: { label: "Built in", url: "" },
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

const MACOS = kind({ kind: "macos", providers: ["blacksmith"], fromHourlyUsd: 4.8, maxLifetimeMinutes: 7200 });
const MAC_OFFERS = offers({
  provider: "blacksmith",
  kind: "macos",
  sizes: [{ id: "m4-6", label: "M4 6 vCPU", vcpu: 6, ramGb: 14, diskGb: null, gpu: null, hourlyUsd: 4.8, regions: [] }],
  regions: [{ id: "gha", label: "GitHub Actions", country: null }],
  images: [{ id: "macos-15", label: "macOS 15" }]
});

const PRESET: NewProjectPreset = {
  kind: "clone-repo",
  url: "https://github.com/JasperRaccoon/JasperEngine.git",
  repoLabel: "JasperRaccoon/JasperEngine"
};

describe("the Runs on row of the new-project modal", () => {
  let root: Root;
  let created: CreateProjectRequest[];
  let typed: unknown[];
  let offerReads: string[];
  let settingsOpened: (string | undefined)[];
  let closed: number;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    created = [];
    typed = [];
    offerReads = [];
    settingsOpened = [];
    closed = 0;
    resetBoxes();
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    useAppStore.setState(initial, true);
    resetBoxes();
  });

  const fakeApi = {
    connection: { id: "c1" },
    listBoxes: async () => ({ boxes: [box()], totals: { activeCount: 1, hourlyUsd: 0.0119, monthEstimatedUsd: 1 } }),
    listBoxProviders: async () => ({
      providers: [provider(), provider({ id: "vultr", label: "Vultr" }), provider({ id: "blacksmith", label: "Blacksmith" })]
    }),
    listBoxKinds: async () => ({
      kinds: [
        kind(),
        kind({ kind: "windows", providers: [], fromHourlyUsd: null, unavailableReason: "Tailscale is not set up on this desktop" }),
        MACOS
      ]
    }),
    listBoxConfigChanges: async () => ({ changes: [change()] }),
    getBoxOffers: async (id: BoxProviderId, k: BoxKind) => {
      offerReads.push(`${id}:${k}`);
      return k === "macos" ? MAC_OFFERS : offers({ provider: id });
    }
  };

  const open = async (enabled: boolean, preset: NewProjectPreset | null = null) => {
    useAppStore.setState({
      api: fakeApi as never,
      plugins: [plugin(enabled)],
      currentWorkspace: "ws",
      workspaces: [{ name: "ws", path: "/w/ws", projectCount: 1 }],
      accounts: [],
      projects: [{ name: "JasperEngine", workspace: "ws", path: "/w/ws/JasperEngine" }],
      listRepos: async () => [],
      listOwners: async () => [],
      openSettings: (section?: string) => {
        settingsOpened.push(section);
      },
      createProject: async (req: CreateProjectRequest) => {
        created.push(req);
      },
      createProjectWithCommand: async (...args: unknown[]) => {
        typed.push(args);
      }
    } as never);
    await act(async () => {
      root.render(createElement(NewProjectModal, { open: true, onClose: () => (closed += 1), preset }));
    });
    await settle();
  };

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
  const card = (title: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.startsWith(title));
  const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const choose = async (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const click = async (el: HTMLElement | undefined) => {
    assert.ok(el, "element present");
    await act(async () => el.click());
    await settle();
  };

  it("is hidden while the plugin is off", async () => {
    await open(false);
    assert.equal(text().includes("Runs on"), false);
    assert.equal(document.querySelector('[role="radio"]') === null, true);
  });

  it("shows this host, one card per kind and Set up more…, unavailable kinds disabled with their reason", async () => {
    await open(true);
    assert.ok(text().includes("Runs on"));
    assert.equal(card("This host")?.getAttribute("aria-checked"), "true");
    assert.ok(card("Linux VM")?.textContent?.includes("Hetzner, Vultr"));
    assert.ok(card("Linux VM")?.textContent?.includes("from $0.0119/h"));
    assert.ok(card("macOS")?.textContent?.includes("$4.80/h · max 5 days"));
    const windows = card("Windows");
    assert.equal(windows?.getAttribute("aria-disabled"), "true");
    assert.equal(windows?.title, "Tailscale is not set up on this desktop");
    await click(windows);
    assert.equal(card("This host")?.getAttribute("aria-checked"), "true");
    assert.ok([...document.querySelectorAll("button")].some((b) => b.textContent === "Set up more…Opens plugin settings"));
  });

  it("a box choice loads its offers and the Empty tab creates in a new VM", async () => {
    await open(true);
    await type(document.querySelector<HTMLInputElement>('input[placeholder="project-name"]')!, "engine-ci");
    await click(card("Linux VM"));
    assert.deepEqual(offerReads, ["hetzner:linux"]);
    assert.equal(select("Size")?.value, "cx22");
    assert.equal(select("Region")?.value, "fsn1");
    assert.match(text(), /≈ \$0\.0119\/h, ~\$8\.69 a month\. The box runs until you delete this project\./);

    await choose(select("Size")!, "ccx13");
    assert.equal(select("Region")?.value, "ash");
    await choose(select("Provider")!, "vultr");
    assert.deepEqual(offerReads, ["hetzner:linux", "vultr:linux"]);

    await click(buttonNamed("Create in a new VM"));
    assert.deepEqual(created, [
      {
        source: "empty",
        name: "engine-ci",
        location: { kind: "box", boxKind: "linux", provider: "vultr", size: "cx22", region: "fsn1" }
      }
    ]);
    assert.equal(closed, 1);
  });

  it("macOS warns with the daily cost and its time limit, and sends the lifetime", async () => {
    await open(true);
    await type(document.querySelector<HTMLInputElement>('input[placeholder="project-name"]')!, "mac-build");
    await click(card("macOS"));
    assert.equal(select("Region") === null, true, "one region: the OS version is asked instead");
    assert.equal(select("OS version")?.value, "macos-15");
    assert.match(
      text(),
      /\$4\.80\/h, about \$115 a day\. macOS boxes are destroyed automatically after at most 5 days \(≈ \$576 if left running\)\. The project row shows a countdown\./
    );
    await choose(select("Lifetime")!, "1440");
    assert.match(text(), /after at most 1 day \(≈ \$115 if left running\)/);
    await click(buttonNamed("Create in a new VM"));
    assert.deepEqual(created[0].location, {
      kind: "box",
      boxKind: "macos",
      provider: "blacksmith",
      size: "m4-6",
      region: "gha",
      image: "macos-15",
      lifetimeMinutes: 1440
    });
  });

  it("without an account, a clone into a box goes server-side instead of being typed", async () => {
    await open(true);
    await click(buttonNamed("Clone"));
    await type(document.querySelector<HTMLInputElement>('input[placeholder="https://github.com/owner/repo.git"]')!, PRESET.url);
    assert.ok(buttonNamed("Review"), "the host path reviews the typed clone");
    await click(card("Linux VM"));
    assert.equal(buttonNamed("Review") === undefined, true);
    await click(buttonNamed("Clone into a new VM"));
    assert.deepEqual(typed, []);
    assert.equal(created.length, 1);
    assert.equal(created[0].source, "clone");
    assert.equal((created[0] as { url: string }).url, PRESET.url);
    assert.equal(created[0].location?.kind, "box");
  });

  it("the preset dialog clones into a new VM with its typed name", async () => {
    await open(true, PRESET);
    await type(document.querySelector<HTMLInputElement>("#new-clone-name")!, "Shader optimization");
    await click(card("Linux VM"));
    await click(buttonNamed("Clone into a new VM"));
    assert.deepEqual(created, [
      {
        source: "clone",
        url: PRESET.url,
        name: "Shader optimization",
        location: { kind: "box", boxKind: "linux", provider: "hetzner", size: "cx22", region: "fsn1" }
      }
    ]);
  });

  it("can't submit until the offers are in; back to this host submits as before", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = fakeApi.getBoxOffers;
    fakeApi.getBoxOffers = async (id, k) => {
      await gate;
      return slow(id, k);
    };
    try {
      await open(true);
      await type(document.querySelector<HTMLInputElement>('input[placeholder="project-name"]')!, "later");
      await click(card("Linux VM"));
      assert.equal(buttonNamed("Create in a new VM")?.disabled, true);
      assert.match(text(), /Loading sizes and prices…/);
      await click(card("This host"));
      await click(buttonNamed("Create"));
      assert.deepEqual(created, [{ source: "empty", name: "later" }]);
      release();
      await settle();
    } finally {
      fakeApi.getBoxOffers = slow;
    }
  });

  it("Set up more… closes the dialog and opens Settings → Plugins", async () => {
    await open(true);
    const setUp = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Set up more…"));
    await click(setUp);
    assert.deepEqual(settingsOpened, ["plugins"]);
    assert.equal(closed, 1);
  });
});
