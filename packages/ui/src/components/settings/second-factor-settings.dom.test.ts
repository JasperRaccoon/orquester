/**
 * Settings → Server's two-step sign-in in a DOM, against a fake client over the remote transport:
 * turning it on goes password → setup → code → enable and shows the codes the daemon returned; an
 * expired pending setup starts over at the password.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type FC } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { authRoutes, type AuthSecondFactorStatusResponse } from "@orquester/api";

// Loaded once the DOM globals exist: React DOM reads them when it loads.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let ApiError: typeof import("../../lib/api-client").ApiError;
let SecondFactorSettings: typeof import("./SecondFactorSettings").SecondFactorSettings;

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
  dom = new JSDOM("<!doctype html><body></body>", { url: "https://orq.example/", pretendToBeVisual: true });
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
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  ({ ApiError } = await import("../../lib/api-client"));
  ({ SecondFactorSettings } = await import("./SecondFactorSettings"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const OFF: AuthSecondFactorStatusResponse = {
  enabled: false,
  enabledAt: null,
  recoveryCodesRemaining: 0,
  unavailable: false,
  lastFailedChallenge: null
};
const ON: AuthSecondFactorStatusResponse = { ...OFF, enabled: true, enabledAt: "2026-11-22T10:00:00.000Z", recoveryCodesRemaining: 10 };
const CODES = ["abcde-fghij", "klmno-pqrst"];
const SETUP = { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Orquester?secret=JBSWY3DPEHPK3PXP", expiresAt: "2026-11-22T10:10:00.000Z" };

describe("two-step sign-in settings", () => {
  let root: Root;
  let calls: Array<[string, unknown]>;

  beforeEach(() => {
    // A closed modal hands focus back on a timer: run it here, while the DOM still exists.
    mock.timers.enable({ apis: ["setTimeout"] });
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
  });

  const render = async <P extends object>(component: FC<P>, props: P, api: Record<string, unknown>) => {
    const client = { connection: { id: "remote", kind: "http", endpoint: "https://orq.example" }, ...api };
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: client as never,
          useTitlebar: false,
          children: createElement(component, props)
        })
      );
    });
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const button = (label: string) =>
    [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const field = (label: string) => {
    const element = [...doc().querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
    return element ? (doc().getElementById(element.htmlFor) as HTMLInputElement | null) : null;
  };
  const click = async (element: Element | undefined) => {
    assert.ok(element, "the control is shown");
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const type = async (input: HTMLInputElement | null, value: string) => {
    assert.ok(input, "the field is shown");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  it("turns it on with the password, then a code, and shows the recovery codes it returned", async () => {
    let status = OFF;
    await render(SecondFactorSettings, {}, {
      secondFactorStatus: async () => status,
      setupSecondFactor: async (password?: string) => {
        calls.push(["setup", password]);
        return SETUP;
      },
      enableSecondFactor: async (code: string) => {
        calls.push(["enable", code]);
        status = ON;
        return { recoveryCodes: CODES };
      }
    });

    await click(button("Set up"));
    await type(field("Password"), "hunter22");
    await click(button("Continue"));
    assert.match(text(), new RegExp(SETUP.secret), "the key is offered for manual entry");
    await type(field("Authentication code"), "123456");
    await click(button("Turn on"));

    assert.deepEqual(calls, [
      ["setup", "hunter22"],
      ["enable", "123456"]
    ]);
    const shown = [...doc().querySelectorAll('[aria-label="Recovery codes"] li')].map((li) => li.textContent);
    assert.deepEqual(shown, CODES);
    await click(button("I've saved these"));
    assert.equal(doc().querySelector('[role="dialog"]'), null);
    assert.ok(button("New recovery codes"), "the section now offers the enabled actions");
  });

  it("starts over at the password when the pending setup expired", async () => {
    await render(SecondFactorSettings, {}, {
      secondFactorStatus: async () => OFF,
      setupSecondFactor: async (password?: string) => {
        calls.push(["setup", password]);
        return SETUP;
      },
      enableSecondFactor: async (code: string) => {
        calls.push(["enable", code]);
        throw new ApiError(409, "POST", authRoutes.secondFactorEnable, undefined, { code: "NO_PENDING_SETUP" });
      }
    });

    await click(button("Set up"));
    await type(field("Password"), "hunter22");
    await click(button("Continue"));
    await type(field("Authentication code"), "123456");
    await click(button("Turn on"));

    assert.ok(field("Password"), "back at the password step");
    assert.equal(field("Authentication code"), null);
    await type(field("Password"), "hunter22");
    await click(button("Continue"));
    assert.deepEqual(calls, [
      ["setup", "hunter22"],
      ["enable", "123456"],
      ["setup", "hunter22"]
    ]);
  });
});
