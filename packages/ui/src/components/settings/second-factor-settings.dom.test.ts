/**
 * Settings → Server's two-step sign-in in a DOM, against a fake client over the remote transport:
 * turning it on goes password → setup → code → enable and shows the codes the daemon returned (which
 * Escape does not dismiss); an expired pending setup starts over at the password; an API token is
 * minted only with the owner's proof, a wrong code landing on the code field; and a just-issued
 * token survives the device-list reload that turning it on triggers.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type FC } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { authRoutes, type AuthSecondFactorProof, type AuthSecondFactorStatusResponse } from "@orquester/api";

// Loaded once the DOM globals exist: React DOM reads them when it loads.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let ApiError: typeof import("../../lib/api-client").ApiError;
let SecondFactorSettings: typeof import("./SecondFactorSettings").SecondFactorSettings;
let AuthSessionsSettings: typeof import("./AuthSessionsSettings").AuthSessionsSettings;
let ServerSettings: typeof import("./ServerSettings").ServerSettings;

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
  ({ AuthSessionsSettings } = await import("./AuthSessionsSettings"));
  ({ ServerSettings } = await import("./ServerSettings"));
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
  const invalidProof = (field: "password" | "code") =>
    new ApiError(403, "POST", authRoutes.tokens, undefined, { code: "INVALID_PROOF", field, message: "wrong" });

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
    await act(async () => {
      doc().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.ok(doc().querySelector('[aria-label="Recovery codes"]'), "Escape does not throw away codes shown once");
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

  it("mints an API token remotely only with the password and a code, a wrong code marked on its field", async () => {
    let attempts = 0;
    await render(AuthSessionsSettings, { remoteAccessOn: true }, {
      listAuthSessions: async () => ({ sessions: [] }),
      secondFactorStatus: async () => ON,
      createApiToken: async (label: string, proof: AuthSecondFactorProof) => {
        calls.push(["token", { label, ...proof }]);
        attempts += 1;
        if (attempts === 1) throw invalidProof("code");
        return {
          token: "orq_secret_token",
          session: { id: "t1", kind: "api", label, createdAt: "2026-11-22T10:00:00.000Z", lastUsedAt: null, expiresAt: null, current: false }
        };
      }
    });

    await click(button("API token"));
    await type(doc().querySelector<HTMLInputElement>('input[aria-label="API token name"]'), "laptop");
    await type(field("Password"), "hunter22");
    await type(field("Authentication code"), "000000");
    await click(button("Create"));

    assert.equal(field("Authentication code")?.getAttribute("aria-invalid"), "true");
    assert.equal(doc().querySelector('[data-testid="issued-token"]'), null);
    await type(field("Authentication code"), "123456");
    await click(button("Create"));

    assert.deepEqual(calls, [
      ["token", { label: "laptop", password: "hunter22", code: "000000" }],
      ["token", { label: "laptop", password: "hunter22", code: "123456" }]
    ]);
    assert.equal(doc().querySelector('[data-testid="issued-token"]')?.textContent, "orq_secret_token");
  });

  it("keeps a just-issued API token on screen when turning two-step sign-in on reloads the device list", async () => {
    let status = OFF;
    let listed = 0;
    await render(ServerSettings, {}, {
      getDaemonConfig: async () => {
        throw new Error("not needed here");
      },
      listAuthSessions: async () => {
        listed += 1;
        return { sessions: [] };
      },
      secondFactorStatus: async () => status,
      createApiToken: async (label: string) => ({
        token: "orq_secret_token",
        session: { id: "t1", kind: "api", label, createdAt: "2026-11-22T10:00:00.000Z", lastUsedAt: null, expiresAt: null, current: false }
      }),
      setupSecondFactor: async () => SETUP,
      enableSecondFactor: async () => {
        status = ON;
        return { recoveryCodes: CODES };
      }
    });

    await click(button("API token"));
    await type(doc().querySelector<HTMLInputElement>('input[aria-label="API token name"]'), "laptop");
    await type(field("Password"), "hunter22");
    await click(button("Create"));
    assert.equal(doc().querySelector('[data-testid="issued-token"]')?.textContent, "orq_secret_token");

    const listedBefore = listed;
    await click(button("Set up"));
    await type(field("Password"), "hunter22");
    await click(button("Continue"));
    await type(field("Authentication code"), "123456");
    await click(button("Turn on"));

    assert.ok(listed > listedBefore, "the device list reloaded after the other devices were signed out");
    assert.equal(doc().querySelector('[data-testid="issued-token"]')?.textContent, "orq_secret_token");
  });
});
