import { after, afterEach, before, beforeEach } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useDeviceStream, type DeviceStreamHandle, type UseDeviceStreamOptions } from "../useDeviceStream.ts";
import { settle } from "./fakes.ts";

/** A mounted hook in an isolated browser, using the platform APIs installed by its test. */
export function streamDom() {
  let dom: JSDOM;
  const globals = ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "navigator"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let frameQueue: FrameRequestCallback[] = [];

  before(() => {
    dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
    const define = (name: string, value: unknown) => {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    };
    for (const name of globals) define(name, (dom.window as unknown as Record<string, unknown>)[name]);
    define("requestAnimationFrame", (callback: FrameRequestCallback) => frameQueue.push(callback));
    define("cancelAnimationFrame", () => {});
    // jsdom has no 2D canvas; a recording context is enough for painting.
    dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const runFrames = () =>
    act(() => {
      const queued = frameQueue;
      frameQueue = [];
      for (const callback of queued) callback(0);
    });


  let root: Root;
  let host: HTMLElement;
  let handle: DeviceStreamHandle;
  const Probe = (props: UseDeviceStreamOptions) => {
    handle = useDeviceStream(props);
    return null;
  };
  beforeEach(() => {
    frameQueue = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    get handle() { return handle; },
    runFrames,
    async render(props: UseDeviceStreamOptions) {
      await act(async () => {
        root.render(createElement(Probe, props));
        await settle();
      });
    }
  };
}
