import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement, Profiler } from "react";
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
  let requests: number;
  let commits: number;

  const refresh = async () => {
    await act(async () => window.dispatchEvent(new Event("focus")));
  };
  const rowNames = () => [...document.querySelectorAll("button > span.flex-1.truncate")].map((node) => node.textContent);

  beforeEach(async () => {
    entries = [file("first.bin"), file("second.bin")];
    requests = 0;
    commits = 0;
    document.body.innerHTML = "<div id='root'></div>";
    root = createRoot(document.getElementById("root")!);
    const api = {
      listFiles: async (path: string) => {
        requests++;
        // The wire always creates new array and entry identities.
        return { path, parent: "/workspace", entries: entries.map((entry) => ({ ...entry })) };
      },
      getFsCapabilities: async () => ({ folderZip: true })
    } as unknown as ApiClient;
    await act(async () => root.render(createElement(OrquesterProvider, {
      runtime: "web", api, useTitlebar: false,
      children: createElement(Profiler, {
        id: "files", onRender: () => { commits++; }, children: createElement(FileBrowser, { rootPath: ROOT, active: true })
      })
    })));
    // Settle React's first no-op state update before measuring repeated polls.
    await refresh();
    commits = 0;
    requests = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("still fetches fresh listings without reconciling an unchanged tree", async () => {
    await refresh();
    await refresh();
    await refresh();
    assert.equal(requests, 3);
    assert.equal(commits, 0);
    assert.deepEqual(rowNames(), ["first.bin", "second.bin"]);
  });

  it("opens the lazy preview on selection and restores the empty pane on Back", async () => {
    // An oversized PDF uses the download card without loading its PDF engine.
    entries = [{ ...file("first.pdf"), size: 30 * 1024 * 1024 }];
    await refresh();
    assert.match(document.body.textContent!, /Select a file to view its contents/);
    assert.doesNotMatch(document.body.textContent!, /first.pdf · 30.0 MB/);
    const first = [...document.querySelectorAll("button > span.flex-1.truncate")]
      .find((node) => node.textContent === "first.pdf")!.parentElement!;
    await act(async () => {
      first.click();
      // Settle the actual preview module load, without timer-based waiting.
      await import("./FilePreview");
    });
    assert.match(document.body.textContent!, /first.pdf · 30.0 MB/);
    assert.doesNotMatch(document.body.textContent!, /Select a file to view its contents/);
    await act(async () => {
      (document.querySelector('[aria-label="Back to files"]') as HTMLButtonElement).click();
    });
    assert.match(document.body.textContent!, /Select a file to view its contents/);
    assert.doesNotMatch(document.body.textContent!, /first.pdf · 30.0 MB/);
    await act(async () => first.click());
    assert.match(document.body.textContent!, /first.pdf · 30.0 MB/);
    assert.doesNotMatch(document.body.textContent!, /Select a file to view its contents/);
  });

  for (const [field, value] of [
    ["name", "renamed.bin"], ["path", `${ROOT}/different.bin`], ["kind", "dir"], ["size", 4096]
  ] as const) {
    it(`applies a changed entry ${field}`, async () => {
      entries = [{ ...entries[0], [field]: value }, entries[1]];
      await refresh();
      assert.ok(commits > 0, `${field} must update the tree's entry data`);
      assert.deepEqual(rowNames(), [field === "name" ? "renamed.bin" : "first.bin", "second.bin"]);
    });
  }

  it("applies reordered, added and removed entries, including an empty listing", async () => {
    entries = [entries[1], entries[0]];
    await refresh();
    assert.deepEqual(rowNames(), ["second.bin", "first.bin"]);
    entries = [...entries, file("third.bin")];
    await refresh();
    assert.deepEqual(rowNames(), ["second.bin", "first.bin", "third.bin"]);
    entries = entries.slice(1);
    await refresh();
    assert.deepEqual(rowNames(), ["first.bin", "third.bin"]);
    entries = [];
    await refresh();
    assert.deepEqual(rowNames(), []);
    assert.match(document.body.textContent!, /Empty directory/);
    await refresh();
    commits = 0;
    await refresh();
    assert.equal(commits, 0);
  });
});
