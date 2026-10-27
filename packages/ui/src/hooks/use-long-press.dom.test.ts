/**
 * `useLongPress` in a DOM: a resting finger opens the menu (iOS fires no
 * `contextmenu`), a tap stays a click, a scroll is not a press, a mouse's
 * right click opens the same menu, and Android's own long-press `contextmenu`
 * racing the timer opens it once.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { useLongPress } from "./use-long-press";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator"] as const;
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

type PointerKind = "touch" | "mouse" | "pen";

function pointer(type: string, init: { x?: number; y?: number; kind?: PointerKind; button?: number } = {}): Event {
  const Ctor = (dom.window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? dom.window.MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerType", { value: init.kind ?? "touch" });
  return event;
}

const mouse = (type: string, x = 0, y = 0): Event =>
  new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: type === "contextmenu" ? 2 : 0 });

describe("useLongPress", () => {
  let root: Root;
  let host: HTMLElement;
  let presses: Array<{ x: number; y: number }>;
  let clicks: number;
  let button: HTMLButtonElement;

  const Row = (): React.ReactElement => {
    const press = useLongPress((point) => {
      presses.push(point);
    });
    return createElement("button", { type: "button", onClick: () => (clicks += 1), ...press }, "row");
  };

  const fire = (event: Event): boolean => {
    let notCancelled = true;
    act(() => {
      notCancelled = button.dispatchEvent(event);
    });
    return notCancelled;
  };
  const finishPress = (): void => {
    act(() => mock.timers.runAll());
  };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    presses = [];
    clicks = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Row)));
    button = host.querySelector("button")!;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mock.timers.reset();
  });

  it("a resting finger opens it once, where it rests, and the click that follows is swallowed", () => {
    fire(pointer("pointerdown", { x: 40, y: 12 }));
    assert.deepEqual(presses, []);
    finishPress();
    assert.deepEqual(presses, [{ x: 40, y: 12 }]);
    fire(pointer("pointerup", { x: 40, y: 12 }));
    fire(mouse("click", 40, 12));
    assert.equal(clicks, 0);
    // The next tap is a plain click again.
    fire(pointer("pointerdown"));
    fire(pointer("pointerup"));
    fire(mouse("click"));
    assert.equal(clicks, 1);
  });

  it("a tap stays a click", () => {
    fire(pointer("pointerdown"));
    act(() => mock.timers.tick(200));
    fire(pointer("pointerup"));
    fire(mouse("click"));
    finishPress();
    assert.deepEqual(presses, []);
    assert.equal(clicks, 1);
  });

  it("a finger that moves (or that the browser takes for a scroll) is not a press", () => {
    fire(pointer("pointerdown", { x: 0, y: 0 }));
    fire(pointer("pointermove", { x: 0, y: 4 }));
    fire(pointer("pointermove", { x: 0, y: 30 }));
    finishPress();
    fire(pointer("pointerdown", { x: 0, y: 0 }));
    fire(pointer("pointercancel"));
    finishPress();
    assert.deepEqual(presses, []);
  });

  it("a mouse never starts the timer; its right click opens the menu", () => {
    fire(pointer("pointerdown", { kind: "mouse" }));
    finishPress();
    assert.deepEqual(presses, []);
    const notCancelled = fire(mouse("contextmenu", 5, 6));
    assert.equal(notCancelled, false, "the browser's own menu is suppressed");
    assert.deepEqual(presses, [{ x: 5, y: 6 }]);
  });

  it("Android's long-press contextmenu and the timer open it once between them", () => {
    fire(pointer("pointerdown", { x: 9, y: 9 }));
    fire(mouse("contextmenu", 9, 9));
    finishPress();
    assert.equal(presses.length, 1);
    fire(pointer("pointerup"));
    fire(mouse("click"));
    assert.equal(clicks, 0);

    // And the other way round: the timer first, then the contextmenu.
    fire(pointer("pointerdown"));
    finishPress();
    fire(mouse("contextmenu"));
    assert.equal(presses.length, 2);
  });

  it("a mouse event the touch still emits does not reach the menu's outside-click listener", () => {
    let outside = 0;
    const onDoc = (): void => {
      outside += 1;
    };
    document.addEventListener("mousedown", onDoc);
    fire(pointer("pointerdown"));
    finishPress();
    fire(mouse("mousedown"));
    assert.equal(outside, 0);
    // A fresh press is an ordinary mousedown again.
    fire(pointer("pointerdown", { kind: "mouse" }));
    fire(mouse("mousedown"));
    assert.equal(outside, 1);
    document.removeEventListener("mousedown", onDoc);
  });

  it("a row unmounted mid-press opens nothing", () => {
    fire(pointer("pointerdown"));
    act(() => root.render(createElement("div")));
    finishPress();
    assert.deepEqual(presses, []);
  });
});
