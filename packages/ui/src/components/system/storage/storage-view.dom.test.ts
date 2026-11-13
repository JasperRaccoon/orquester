/**
 * Settings → Host status → Storage in a DOM, with a fake API client: the tab
 * reads nothing until it opens, scan progress follows `storage.changed`, the
 * map follows the picked volume and folder, refused actions are disabled with
 * their reason, a typed-confirm delete gates its button, and a folder that is
 * gone falls back to the volume root.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  StorageDeleteRequest,
  StorageNode,
  StorageScanSummary,
  StorageStatusResponse,
  StorageTreeResponse,
  StorageVolume
} from "@orquester/api";

// Loaded once the DOM globals exist: React DOM reads them when it loads.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;
let HostStatusView: typeof import("../SystemSettings").HostStatusView;
let useAppStore: typeof import("../../../store/app").useAppStore;
let ApiError: typeof import("../../../lib/api-client").ApiError;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
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
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
  ({ HostStatusView } = await import("../SystemSettings"));
  ({ useAppStore } = await import("../../../store/app"));
  ({ ApiError } = await import("../../../lib/api-client"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const scanSummary = (finishedAt: string): StorageScanSummary => ({
  startedAt: "2026-11-13T02:00:00.000Z",
  finishedAt,
  durationMs: 240_000,
  trigger: "schedule",
  scannerVersion: "v5.39.0",
  scannedBytes: 50 * 2 ** 30,
  apparentBytes: 48 * 2 ** 30,
  items: 120_000,
  unreadableDirs: 2,
  usedBytesAtScan: 52 * 2 ** 30,
  unaccountedBytes: 2 * 2 ** 30
});

const volumeOf = (id: string, lastScan: StorageScanSummary | null): StorageVolume => ({
  id,
  mountPoint: id,
  device: "/dev/md2",
  fsType: "ext4",
  totalBytes: 100 * 2 ** 30,
  usedBytes: 52 * 2 ** 30,
  freeBytes: 48 * 2 ** 30,
  lastScan
});

const statusOf = (over: Partial<StorageStatusResponse> = {}): StorageStatusResponse => ({
  supported: true,
  scanner: { installed: true, version: "v5.39.0", path: "/usr/local/bin/gdu" },
  volumes: [volumeOf("/", scanSummary("2026-11-13T02:04:00.000Z")), volumeOf("/data", scanSummary("2026-11-13T02:10:00.000Z"))],
  scan: { state: "idle" },
  lastError: null,
  nextScheduledAt: "2026-11-14T02:00:00.000Z",
  ...over
});

const allowed = { delete: null, rename: null, download: null, confirmDelete: false };

const dir = (path: string, over: Partial<StorageNode> = {}): StorageNode => ({
  name: path.slice(path.lastIndexOf("/") + 1) || path,
  path,
  kind: "dir",
  sizeBytes: 2 ** 30,
  apparentBytes: 2 ** 30,
  items: 10,
  hasChildren: true,
  actions: allowed,
  ...over
});

const treeOf = (volume: string, root: StorageNode, ancestors: StorageTreeResponse["ancestors"] = []): StorageTreeResponse => ({
  volume,
  scan: scanSummary("2026-11-13T02:04:00.000Z"),
  root,
  ancestors
});

interface Fake {
  calls: string[];
  deletes: StorageDeleteRequest[];
  status: StorageStatusResponse;
  /** Keyed `${volume}|${path ?? ""}`; a missing key 404s STORAGE_PATH_NOT_FOUND. */
  trees: Map<string, StorageTreeResponse>;
}

describe("Host status → Storage", () => {
  let root: Root;
  let fake: Fake;

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    fake = { calls: [], deletes: [], status: statusOf(), trees: new Map() };
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const notFound = (code: string) => new ApiError(404, "GET", "/api/system/storage/tree", {}, { code, message: code });

  const api = () => ({
    connection: { id: "c1", endpoint: "http://daemon", password: "" },
    transportKind: "http",
    agentHostStatus: async () => {
      throw new Error("not under test");
    },
    storageStatus: async () => {
      fake.calls.push("status");
      return fake.status;
    },
    startStorageScan: async ({ volume }: { volume: string }) => {
      fake.calls.push(`scan ${volume}`);
      return fake.status;
    },
    cancelStorageScan: async () => {
      fake.calls.push("cancel");
      return fake.status;
    },
    storageTree: async (volume: string, path?: string) => {
      fake.calls.push(`tree ${volume} ${path ?? "(root)"}`);
      const tree = fake.trees.get(`${volume}|${path ?? ""}`);
      if (!tree) throw notFound("STORAGE_PATH_NOT_FOUND");
      return tree;
    },
    deleteStorageEntry: async (request: StorageDeleteRequest) => {
      fake.deletes.push(request);
      return { ok: true, freedBytes: 2 ** 30 };
    },
    renameStorageEntry: async () => ({ ok: true, path: "/renamed" })
  });

  const idlePoll = { data: null, error: null, loading: false, unavailable: false, refresh: () => {} };
  const hostStatus = {
    live: false,
    resources: idlePoll,
    processes: idlePoll,
    ports: idlePoll,
    refreshing: false,
    refreshAll: () => {},
    updatedAt: null
  };

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const show = async () => {
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: api() as never,
          useTitlebar: false,
          children: createElement(HostStatusView, { status: hostStatus as never })
        })
      );
    });
    await flush();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const buttons = () => [...doc().querySelectorAll("button")] as HTMLButtonElement[];
  const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
  const menuItem = (label: string) =>
    ([...doc().querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]).find((b) =>
      b.textContent?.startsWith(label)
    );
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };
  /** Right-click the map entry showing `name` (whatever element the list renders it in). */
  const rightClick = async (name: string) => {
    const target = [...doc().querySelectorAll("*")].reverse().find((el) => el.textContent?.trim() === name);
    assert.ok(target, `an entry named ${name}`);
    await act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    await flush();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const openStorage = async () => {
    await click(doc().getElementById("host-tab-storage")!);
  };
  const emit = async (payload: unknown) => {
    await act(async () => {
      useAppStore.getState().applyEvent({ id: "e1", channel: "storage", type: "storage.changed", createdAt: "", payload });
    });
    await flush();
  };

  const rootTree = () =>
    treeOf("/", dir("/", { children: [dir("/var"), dir("/srv", { actions: { ...allowed, delete: "/srv is a top-level system folder", rename: "/srv is a top-level system folder" } })] }));

  it("reads nothing until the Storage tab opens", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    assert.deepEqual(fake.calls, []);
    await openStorage();
    assert.deepEqual(fake.calls, ["status", "tree / (root)"]);
    assert.ok(text().includes("var"));
  });

  it("Scan now starts a scan and its progress follows storage.changed", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    await openStorage();
    await click(button("Scan now")!);
    assert.ok(fake.calls.includes("scan /"));

    await emit(
      statusOf({
        scan: {
          state: "scanning",
          volume: "/",
          trigger: "manual",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          expectedDurationMs: 240_000,
          queued: ["/data"]
        }
      })
    );
    const bar = doc().querySelector('[role="progressbar"]');
    assert.ok(bar, "a progress bar while scanning");
    const value = Number(bar.getAttribute("aria-valuenow"));
    assert.ok(value >= 20 && value < 40, `about a quarter of the expected time: ${value}`);
    assert.ok(button("Cancel"), "a Cancel while scanning");
    assert.equal(button("Scan now")!.disabled, true, "one scan at a time");

    await emit({ supported: true, volumes: "garbage" });
    assert.ok(doc().querySelector('[role="progressbar"]'), "a malformed event changes nothing");

    // The cancel's answer is the idle status.
    await click(button("Cancel")!);
    assert.ok(fake.calls.includes("cancel"));
    assert.equal(doc().querySelector('[role="progressbar"]'), null);
  });

  it("a finished scan of the shown volume reads its map again", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    await openStorage();
    const before = fake.calls.filter((c) => c === "tree / (root)").length;
    await emit(statusOf({ volumes: [volumeOf("/", scanSummary("2026-11-13T09:00:00.000Z")), volumeOf("/data", scanSummary("2026-11-13T02:10:00.000Z"))] }));
    assert.equal(fake.calls.filter((c) => c === "tree / (root)").length, before + 1);
  });

  it("a delete elsewhere that edits the shown volume's scan reads its map again", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    await openStorage();
    const before = fake.calls.filter((c) => c === "tree / (root)").length;
    // The daemon edits the saved scan in place: same finishedAt, smaller totals.
    const edited = { ...scanSummary("2026-11-13T02:04:00.000Z"), scannedBytes: 49 * 2 ** 30, items: 119_000 };
    await emit(statusOf({ volumes: [volumeOf("/", edited), volumeOf("/data", scanSummary("2026-11-13T02:10:00.000Z"))] }));
    assert.equal(fake.calls.filter((c) => c === "tree / (root)").length, before + 1);
  });

  it("switching volume reads that volume's map", async () => {
    fake.trees.set("/|", rootTree());
    fake.trees.set("/data|", treeOf("/data", dir("/data", { children: [dir("/data/backups")] })));
    await show();
    await openStorage();
    const chip = buttons().find((b) => b.getAttribute("aria-pressed") !== null && b.textContent?.includes("/data"));
    assert.ok(chip, "a chip for /data");
    await click(chip);
    assert.ok(fake.calls.includes("tree /data (root)"));
    assert.ok(text().includes("backups"));
  });

  it("opening a folder reads its subtree and the breadcrumb zooms back out", async () => {
    fake.trees.set("/|", rootTree());
    fake.trees.set("/|/var", treeOf("/", dir("/var", { children: [dir("/var/log")] }), [{ name: "/", path: "/" }]));
    await show();
    await openStorage();
    await rightClick("var");
    await click(menuItem("Open")!);
    assert.ok(fake.calls.includes("tree / /var"));
    assert.ok(text().includes("log"));

    const crumb = [...doc().querySelectorAll('nav[aria-label="Folder path"] button')].find((b) => b.textContent === "/");
    assert.ok(crumb, "a breadcrumb for the volume root");
    await click(crumb);
    assert.ok(text().includes("srv"), "back at the volume root");
    assert.equal(doc().querySelector('nav[aria-label="Folder path"] button'), null, "the root has no crumbs above it");
  });

  it("disables the actions the guard refuses, with the reason", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    await openStorage();
    await rightClick("srv");
    const remove = menuItem("Delete")!;
    assert.equal(remove.disabled, true);
    assert.ok(remove.textContent?.includes("/srv is a top-level system folder"));
    assert.equal(menuItem("Rename")!.disabled, true);
    assert.equal(menuItem("Download as Zip")!.disabled, false);
  });

  it("a typed-confirm delete stays disabled until the exact name is typed, then sends it", async () => {
    fake.trees.set(
      "/|",
      treeOf("/", dir("/", { children: [dir("/scratch", { actions: { ...allowed, confirmDelete: true } })] }))
    );
    await show();
    await openStorage();
    await rightClick("scratch");
    await click(menuItem("Delete")!);

    const confirm = () => buttons().find((b) => b.textContent?.trim() === "Delete" && b.getAttribute("role") !== "menuitem")!;
    const input = doc().querySelector('input[placeholder="scratch"]') as HTMLInputElement;
    assert.ok(input, "a field to type the name into");
    assert.equal(confirm().disabled, true);
    await type(input, "scratc");
    assert.equal(confirm().disabled, true);
    await type(input, "scratch");
    assert.equal(confirm().disabled, false);
    await click(confirm());
    assert.deepEqual(fake.deletes, [{ path: "/scratch", confirm: "scratch" }]);
    assert.ok(text().includes("freed 1.0 GB"), text());
  });

  it("rename refuses a name the daemon would refuse", async () => {
    fake.trees.set("/|", rootTree());
    await show();
    await openStorage();
    await rightClick("var");
    await click(menuItem("Rename")!);
    const input = doc().querySelector('input[aria-label="New name"]') as HTMLInputElement;
    const submit = () => input.form!.querySelector('button[type="submit"]') as HTMLButtonElement;
    await type(input, "logs");
    assert.equal(submit().disabled, false);
    await type(input, "a\\b");
    assert.equal(submit().disabled, true);
  });

  it("a folder that no longer exists falls back to the volume root", async () => {
    fake.trees.set("/|", rootTree());
    fake.trees.set("/|/var", treeOf("/", dir("/var", { children: [dir("/var/log")] }), [{ name: "/", path: "/" }]));
    await show();
    await openStorage();
    await rightClick("var");
    await click(menuItem("Open")!);
    fake.trees.delete("/|/var");
    fake.trees.delete("/|");
    fake.trees.set("/|", treeOf("/", dir("/", { children: [dir("/srv")] })));
    // A newer scan no longer has /var.
    await emit(statusOf({ volumes: [volumeOf("/", scanSummary("2026-11-13T09:00:00.000Z")), volumeOf("/data", scanSummary("2026-11-13T02:10:00.000Z"))] }));
    assert.deepEqual(fake.calls.slice(-2), ["tree / /var", "tree / (root)"]);
    assert.ok(text().includes("srv"));
    assert.ok(!text().includes("Could not read the scan"));
  });

  it("an older daemon without the storage routes says so", async () => {
    await show();
    const apiWithout = { ...api(), storageStatus: async () => { throw new ApiError(404, "GET", "/api/system/storage", {}, { code: "NOT_FOUND", message: "Route not found." }); } };
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: apiWithout as never,
          useTitlebar: false,
          children: createElement(HostStatusView, { status: hostStatus as never })
        })
      );
    });
    await openStorage();
    assert.ok(text().includes("does not report host storage"), text());
  });
});
