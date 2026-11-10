/**
 * The typed Run now form, mounted: an overlap skip is shown in the form with
 * the daemon's reason (a previous run waits on a gate) and its own "Run
 * anyway", which runs again with `force`.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { RunNowResult } from "./RunNowPopover";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let RunInputsDialog: typeof import("./RunInputsDialog").RunInputsDialog;

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
  "requestAnimationFrame",
  "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
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
  ({ RunInputsDialog } = await import("./RunInputsDialog"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let mount: HTMLDivElement;
let root: Root;
let runs: { input: unknown; force: boolean }[];
let answer: RunNowResult;

function render(phone: boolean): void {
  act(() => {
    root.render(
      createElement(RunInputsDialog, {
        open: true,
        onClose: () => undefined,
        workflowName: "Deploy",
        inputs: [{ name: "branch", type: "string" }],
        phone,
        onRun: async (input: unknown, options: { force: boolean }) => {
          runs.push({ input, force: options.force });
          return answer;
        }
      })
    );
  });
}

async function submit(): Promise<void> {
  const form = dom.window.document.querySelector("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...dom.window.document.querySelectorAll("button")].find((candidate) => name.test(candidate.textContent ?? ""));
  assert.ok(found, String(name));
  return found as HTMLButtonElement;
}

beforeEach(() => {
  // The modal and the sheet hand focus back on a timer once closed: run it here, not after the DOM is gone.
  mock.timers.enable({ apis: ["setTimeout"] });
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  runs = [];
});

afterEach(() => {
  act(() => root.unmount());
  mock.timers.runAll();
  mock.timers.reset();
});

describe("the typed Run now form's overlap skip", () => {
  for (const phone of [false, true]) {
    it(`says why it was skipped, and runs anyway with force (${phone ? "phone" : "desktop"})`, async () => {
      answer = { ok: true, runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Deploy?”" };
      render(phone);
      await submit();
      const text = dom.window.document.body.textContent ?? "";
      assert.match(text, /This run was skipped: previous run is waiting on gate “Deploy\?”\./);
      assert.doesNotMatch(text, /overlap: skip/);
      await act(async () => {
        button(/^Run anyway$/).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      assert.deepEqual(runs.map((run) => run.force), [false, true]);
    });
  }

  it("without a reason, says it is already running", async () => {
    answer = { ok: true, runId: null, skipped: "overlap" };
    render(false);
    await submit();
    assert.match(dom.window.document.body.textContent ?? "", /It is already running, so this run was skipped \(overlap: skip\)\./);
  });
});
