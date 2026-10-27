import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { FsEntry } from "@orquester/api";
import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let FileBrowser: typeof import("./FileBrowser").FileBrowser;
let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "Event", "MouseEvent", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ FileBrowser } = await import("./FileBrowser"));
});

after(() => {
  dom.window.close();
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const ROOT = "/workspace/project";
const file = (name: string): FsEntry => ({ name, path: `${ROOT}/${name}`, kind: "file", size: 1024 });

describe("file-tree refreshes", () => {
  let root: Root;
  let entries: FsEntry[];
  let requestedPaths: string[];
  let readPaths: string[];

  const button = (name: string) => [...document.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === name);
  const back = () => document.querySelector<HTMLButtonElement>('[aria-label="Back to files"]');
  const rowNames = () => [...document.querySelectorAll("button")]
    .map((node) => node.textContent?.trim()).filter((name) => name?.endsWith(".bin")).sort();
  const refresh = async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click());
  };
  const openPreview = async () => {
    await act(async () => {
      button("first.pdf")!.click();
      await import("./FilePreview");
    });
  };

  beforeEach(async () => {
    entries = [file("first.bin"), file("second.bin")];
    requestedPaths = [];
    readPaths = [];
    document.body.innerHTML = "<div id='root'></div>";
    root = createRoot(document.getElementById("root")!);
    const api = {
      listFiles: async (path: string) => {
        requestedPaths.push(path);
        const listing = path === ROOT ? entries : [{ ...file("child.bin"), path: `${path}/child.bin` }];
        return { path, parent: "/workspace", entries: listing.map((entry) => ({ ...entry })) };
      },
      readFileBytes: async (path: string) => {
        readPaths.push(path);
        throw new Error("Download unavailable in this fixture");
      },
      getFsCapabilities: async () => ({ folderZip: true })
    } as unknown as ApiClient;
    await act(async () => root.render(createElement(OrquesterProvider, {
      runtime: "web", api, useTitlebar: false,
      children: createElement(FileBrowser, { rootPath: ROOT, active: false })
    })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("refreshes renamed, added and removed files, including an empty directory", async () => {
    assert.deepEqual(rowNames(), ["first.bin", "second.bin"]);
    entries = [file("renamed.bin"), file("second.bin")];
    await refresh();
    assert.deepEqual(rowNames(), ["renamed.bin", "second.bin"]);
    entries.push(file("third.bin"));
    await refresh();
    assert.deepEqual(rowNames(), ["renamed.bin", "second.bin", "third.bin"]);
    entries = entries.filter((entry) => entry.name !== "second.bin");
    await refresh();
    assert.deepEqual(rowNames(), ["renamed.bin", "third.bin"]);
    entries = [];
    await refresh();
    assert.deepEqual(rowNames(), []);
  });

  it("opens the selected file, returns with Back and honors refreshed download size", async () => {
    entries = [{ ...file("first.pdf"), size: 30 * 1024 * 1024 }];
    await refresh();
    assert.ok(back() === null, "the element is absent");
    await openPreview();
    assert.ok(back());
    await act(async () => button("Download")!.click());
    assert.deepEqual(readPaths, [`${ROOT}/first.pdf`]);
    await act(async () => back()!.click());
    assert.ok(back() === null, "the element is absent");
    await openPreview();
    assert.ok(back(), "the same file can be opened again after Back");
    await act(async () => back()!.click());

    // The raw-file route's 50 MiB ceiling must use the refreshed entry size.
    entries = [{ ...file("first.pdf"), size: 60 * 1024 * 1024 }];
    await refresh();
    await openPreview();
    assert.ok(back());
    assert.ok(button("Download") === undefined, "an oversized file cannot use the buffered download");
  });

  it("refreshes a file replaced by a directory and opens its listing", async () => {
    entries = [{ ...file("first.bin"), kind: "dir" }, file("second.bin")];
    await refresh();
    await act(async () => button("first.bin")!.click());
    assert.equal(requestedPaths.at(-1), `${ROOT}/first.bin`);
    assert.ok(button("child.bin"), "a refreshed directory opens its children rather than a file preview");
  });
});
