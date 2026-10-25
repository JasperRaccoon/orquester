/**
 * The code-split views' helpers in a DOM: a lazy dialog loads nothing until it
 * first opens and then stays mounted across a close; a chunk that fails to
 * load leaves a "Reload" card in place of its view, while any other error
 * still reaches the boundary above.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import React, { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { LazyBoundary, lazyDialog, lazyNamed } from "./lazy";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
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
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/** A module promise the test settles by hand. */
function deferredModule<M>() {
  let resolve!: (module: M) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<M>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Outer extends React.Component<React.PropsWithChildren, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error === null ? this.props.children : createElement("p", null, "outer caught");
  }
}

describe("lazy views", () => {
  let root: Root;
  let host: HTMLElement;
  const originalConsoleError = console.error;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // React logs every error a boundary catches; the ones here are expected.
    console.error = () => {};
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    console.error = originalConsoleError;
  });

  it("a lazy dialog loads with its first opening and stays mounted across a close", async () => {
    let loads = 0;
    let mounts = 0;
    const Dialog: React.FC<{ open: boolean }> = ({ open }) => {
      React.useEffect(() => {
        mounts += 1;
      }, []);
      return createElement("p", null, open ? "dialog open" : "dialog closed");
    };
    const pending = deferredModule<{ Dialog: typeof Dialog }>();
    const LazyDialog = lazyDialog(
      lazyNamed(() => {
        loads += 1;
        return pending.promise;
      }, "Dialog")
    );

    act(() => root.render(createElement(LazyDialog, { open: false })));
    assert.equal(loads, 0);
    assert.equal(host.textContent, "");

    act(() => root.render(createElement(LazyDialog, { open: true })));
    assert.equal(loads, 1);
    assert.ok(document.querySelector('[role="status"]'), "a loading overlay while the chunk loads");

    await act(async () => {
      pending.resolve({ Dialog });
      await pending.promise;
    });
    assert.equal(host.textContent, "dialog open");

    act(() => root.render(createElement(LazyDialog, { open: false })));
    assert.equal(host.textContent, "dialog closed");
    act(() => root.render(createElement(LazyDialog, { open: true })));
    assert.equal(host.textContent, "dialog open");
    assert.equal(mounts, 1);
    assert.equal(loads, 1);
  });

  it("a chunk that fails to load leaves a Reload card in place of the view", async () => {
    const pending = deferredModule<{ View: React.FC }>();
    const View = lazyNamed(() => pending.promise, "View");
    act(() =>
      root.render(
        createElement(Outer, null, createElement(LazyBoundary, null, createElement(View)), createElement("p", null, "sibling"))
      )
    );
    await act(async () => {
      pending.reject(new Error("Failed to fetch dynamically imported module"));
      await pending.promise.catch(() => undefined);
    });
    assert.ok(document.querySelector('[role="alert"]'));
    assert.match(host.textContent ?? "", /could not be loaded/);
    assert.match(host.textContent ?? "", /Reload/);
    assert.match(host.textContent ?? "", /sibling/, "the rest of the app stays");
  });

  it("any other error in a lazy view still reaches the boundary above", async () => {
    const Throws: React.FC = () => {
      throw new Error("render crash");
    };
    const pending = deferredModule<{ Throws: React.FC }>();
    const View = lazyNamed(() => pending.promise, "Throws");
    act(() => root.render(createElement(Outer, null, createElement(LazyBoundary, null, createElement(View)))));
    await act(async () => {
      pending.resolve({ Throws });
      await pending.promise;
    });
    assert.equal(host.textContent, "outer caught");
  });
});
