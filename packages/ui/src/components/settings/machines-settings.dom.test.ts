/**
 * Settings → Machines in a DOM: Pair over SSH sends the overrides, shows an unknown host key and
 * pairs only with the fingerprint the owner confirmed, and a refused pairing shows its named fix;
 * a visibility choice and a capability switch send exactly that change; Wake is offered only where
 * something can send it, and says which machine did. (The pairing test runs
 * first: its dialog's focus-return tick lands while the DOM still exists.)
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EPHEMERAL_VMS_PLUGIN_ID, type MachineSummary, type PairMachineOverSshResponse, type PluginInfo, type WakeMachineResponse } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let MachinesSettings: typeof import("./MachinesSettings").MachinesSettings;
let resetMachines: typeof import("../../lib/machines/store").resetMachines;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ MachinesSettings } = await import("./MachinesSettings"));
  ({ resetMachines } = await import("../../lib/machines/store"));
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

const vmsPlugin = { id: EPHEMERAL_VMS_PLUGIN_ID, name: "Ephemeral AI VMs", scope: "global", enabled: true } as unknown as PluginInfo;

const mac: MachineSummary = {
  id: "ts:nMAC",
  name: "Eduard’s MacBook Pro",
  hostname: "Eduard’s MacBook Pro",
  dnsName: "eduards-macbook-pro.tail0000.ts.net",
  os: "macos",
  tailnetIps: ["100.64.0.3"],
  online: true,
  lastSeenAt: null,
  state: "not-paired",
  visibility: "hidden",
  capabilities: { devices: false, commands: false, chats: false },
  boxId: null,
  wake: { canWake: false },
  sudo: {},
  problems: []
};

describe("MachinesSettings", () => {
  let root: Root;
  let calls: Array<[string, string, unknown]>;
  let pairAnswers: PairMachineOverSshResponse[];
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    pairAnswers = [];
    initial = { ...useAppStore.getState() };
    resetMachines();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetMachines();
  });

  const show = async (machines: MachineSummary[] = [mac], wakeAnswer: WakeMachineResponse = { sent: false, via: null }) => {
    const api = {
      connection: { id: "test" },
      listMachines: async () => ({ machines, problems: [] }),
      updateMachine: async (id: string, req: unknown) => {
        calls.push(["update", id, req]);
        return { machine: mac };
      },
      removeMachine: async () => ({ uninstalled: true, problems: [] }),
      pairMachineOverSsh: async (id: string, req: unknown) => {
        calls.push(["pair", id, req]);
        return pairAnswers.shift()!;
      },
      wakeMachine: async (id: string) => {
        calls.push(["wake", id, null]);
        return wakeAnswer;
      }
    };
    useAppStore.setState({ api: api as never, connectionStatus: "connected", plugins: [vmsPlugin] } as never);
    await act(async () => root.render(createElement(MachinesSettings)));
    await act(async () => undefined);
  };

  const doc = () => dom.window.document;
  const byLabel = (label: string) => doc().querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  const button = (text: string) => [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  it("Pair over SSH: overrides go with the request, an unknown host key is confirmed by its fingerprint, a refusal shows its fix", async () => {
    await show();
    pairAnswers.push(
      { status: "confirm-host-key", hostKey: { keyType: "ssh-ed25519", fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", host: "eduards-macbook-pro.tail0000.ts.net" } },
      { status: "failed", problem: { code: "ssh-auth-refused", machineId: mac.id, message: "SSH login to the Mac was refused.", fix: "Add this server's key to ~/.ssh/authorized_keys for mapacho." } }
    );
    await click(byLabel(`Pair ${mac.name} over SSH`)!);
    await type(doc().querySelector<HTMLInputElement>("#pair-port")!, "70000");
    await click(button("Connect")!);
    assert.deepEqual(calls, [], "a bad port is caught before anything is sent");
    await type(doc().querySelector<HTMLInputElement>("#pair-port")!, "2222");
    await type(doc().querySelector<HTMLInputElement>("#pair-user")!, "mapacho");
    await click(button("Connect")!);
    assert.ok(doc().body.textContent?.includes("SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"));
    await click(button("Trust this key and pair")!);
    assert.deepEqual(calls, [
      ["pair", mac.id, { user: "mapacho", port: 2222 }],
      ["pair", mac.id, { user: "mapacho", port: 2222, acceptHostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" }]
    ]);
    assert.ok(doc().body.textContent?.includes("Add this server's key to ~/.ssh/authorized_keys for mapacho."));
  });

  it("a visibility choice and a capability switch each send only that change", async () => {
    await show();
    const free = [...byLabel(`Who may use ${mac.name}`)!.querySelectorAll('[role="radio"]')].find((radio) => radio.textContent === "Free use")!;
    await click(free);
    await click(byLabel(`Commands and SSH on ${mac.name}`)!);
    assert.deepEqual(calls, [
      ["update", mac.id, { visibility: "free" }],
      ["update", mac.id, { capabilities: { commands: true } }]
    ]);
  });

  it("Wake shows on an asleep machine that has a sender, and says which machine sent it", async () => {
    const jasper: MachineSummary = { ...mac, id: "ts:nJASPER", name: "jasper", os: "linux", state: "asleep", boxId: "byo-jasper", visibility: "ask", wake: { canWake: true, via: "ts:nMINIPC" } };
    const minipc: MachineSummary = { ...mac, id: "ts:nMINIPC", name: "minipc", os: "windows", state: "ready", boxId: "byo-minipc", visibility: "ask" };
    const noSender: MachineSummary = { ...jasper, id: "ts:nSTUDIO", name: "studio", wake: { canWake: false } };
    await show([jasper, minipc, noSender], { sent: true, via: "ts:nMINIPC" });
    assert.equal(byLabel("Wake studio"), null, "no sender: no Wake button");
    assert.equal(byLabel("Wake minipc"), null, "awake: no Wake button");
    await click(byLabel("Wake jasper")!);
    assert.deepEqual(calls, [["wake", "ts:nJASPER", null]]);
    assert.match(byLabel("jasper")!.textContent ?? "", /through minipc/);
  });
});
