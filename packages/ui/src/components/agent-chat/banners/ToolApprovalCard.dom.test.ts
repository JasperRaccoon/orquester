/**
 * An Orquester approval card, mounted (unified MCP §7.1): it never takes focus, ⌘/Ctrl+Enter is
 * ignored for 1.5 s after the card appears or changes, Enter alone never approves, typed secrets
 * leave the card's state once sent, the deny reason goes with a denial, "View all" fetches the
 * whole preview, and a grant is only ever one the card offered.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  parseToolApprovalSummary,
  TOOL_APPROVAL_KEYBOARD_GUARD_MS,
  type ParsedToolApprovalSummary,
  type ToolApprovalAnswer
} from "@orquester/api/agent-chat";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use
// (a text field's `onChange` needs the `input` event).
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ToolApprovalCard: typeof import("./ToolApprovalCard").ToolApprovalCard;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
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
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ToolApprovalCard } = await import("./ToolApprovalCard"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const START = Date.parse("2026-10-15T10:00:00.000Z");
let clock = START;
const now = (): number => clock;

function card(overrides: Record<string, unknown> = {}): ParsedToolApprovalSummary {
  const parsed = parseToolApprovalSummary({
    approvalId: "ap-1",
    threadId: "s1",
    tool: "control_desktop",
    kind: "admin",
    family: "desktops",
    title: "Claude wants to open a desktop",
    scope: { label: "Project acme/web" },
    sections: [{ kind: "fields", rows: [{ label: "command", value: "npm run dev" }] }],
    fullPreview: false,
    secretFields: [],
    grantOptions: [],
    requestedAt: "2026-10-15T09:59:00.000Z",
    expiresAt: "2026-10-15T10:29:00.000Z",
    ...overrides
  });
  assert.ok(parsed);
  return parsed;
}

let mount: HTMLDivElement;
let composer: HTMLTextAreaElement;
let root: Root;
let answers: ToolApprovalAnswer[];
let loads: number;
let full: ParsedToolApprovalSummary | null;

function render(summary: ParsedToolApprovalSummary, isMobile = false): void {
  act(() => {
    root.render(
      createElement(ToolApprovalCard, {
        key: summary.approvalId,
        card: summary,
        pendingCount: 1,
        isMobile,
        now,
        onAnswer: async (answer: ToolApprovalAnswer) => {
          answers.push(answer);
        },
        onLoadFull: async () => {
          loads += 1;
          return full;
        }
      })
    );
  });
}

function q<T extends Element>(selector: string): T {
  const element = dom.window.document.querySelector<T>(selector);
  assert.ok(element, selector);
  return element;
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A pointer click: `detail` is the click count (1, then 2 for a double click's second). */
function pointerClick(target: Element, detail: number): void {
  act(() => {
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  const document = dom.window.document;
  mount = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.replaceChildren(composer, mount);
  root = createRoot(mount);
  clock = START;
  answers = [];
  loads = 0;
  full = null;
});

// Unmounted after every test, failed ones included: the card's countdown is an interval.
afterEach(() => {
  act(() => root.unmount());
});

describe("ToolApprovalCard", () => {
  it("never takes focus: the composer keeps it when the card appears", () => {
    composer.focus();
    render(card({ secretFields: [{ key: "TOKEN", label: "Token" }], grantOptions: ["chat"] }));
    assert.equal(dom.window.document.activeElement, composer);
  });

  it("ignores ⌘/Ctrl+Enter for 1.5 s after the card appears, then approves", async () => {
    render(card());
    const group = q('[data-tool-approval="ap-1"]');
    clock = START + TOOL_APPROVAL_KEYBOARD_GUARD_MS - 1;
    key(group, { key: "Enter", ctrlKey: true });
    await flush();
    assert.equal(answers.length, 0);
    clock = START + TOOL_APPROVAL_KEYBOARD_GUARD_MS;
    key(group, { key: "Enter", metaKey: true });
    await flush();
    assert.deepEqual(answers, [{ decision: "approve" }]);
  });

  it("restarts the guard when the card changes", async () => {
    render(card());
    clock = START + 10_000;
    render(card({ title: "Claude wants to open TWO desktops" }));
    key(q('[data-tool-approval="ap-1"]'), { key: "Enter", ctrlKey: true });
    await flush();
    assert.equal(answers.length, 0);
    clock = START + 10_000 + TOOL_APPROVAL_KEYBOARD_GUARD_MS;
    key(q('[data-tool-approval="ap-1"]'), { key: "Enter", ctrlKey: true });
    await flush();
    assert.equal(answers.length, 1);
  });

  it("Enter alone never approves — not even on the focused Approve button", async () => {
    render(card());
    clock = START + 60_000;
    const approve = q<HTMLButtonElement>("[data-approve]");
    approve.focus();
    // jsdom never turns Enter into a click by itself: what proves the browser would not either is
    // that the card cancelled the key's default action on the focused button.
    const enter = key(approve, { key: "Enter" });
    assert.equal(enter.defaultPrevented, true, "Enter on the focused Approve button is cancelled");
    key(q('[data-tool-approval="ap-1"]'), { key: "Enter" });
    await flush();
    assert.equal(answers.length, 0);
    // Shift is someone else's chord (⌘/Ctrl+Shift+Enter steers the queue).
    key(approve, { key: "Enter", ctrlKey: true, shiftKey: true });
    await flush();
    assert.equal(answers.length, 0);
  });

  it("the composer's own ⌘/Ctrl+Enter never reaches the card", async () => {
    render(card());
    clock = START + 60_000;
    key(composer, { key: "Enter", ctrlKey: true });
    await flush();
    assert.equal(answers.length, 0);
  });

  it("sends typed secrets with the approval and clears them from the card", async () => {
    render(card({ secretFields: [{ key: "TOKEN", label: "Token" }] }));
    const approve = q<HTMLButtonElement>("[data-approve]");
    assert.equal(approve.disabled, true);
    const input = q<HTMLInputElement>('input[type="password"]');
    type(input, "s3cret-value");
    assert.equal(approve.disabled, false);
    act(() => approve.click());
    await flush();
    assert.deepEqual(answers, [{ decision: "approve", secrets: { TOKEN: "s3cret-value" } }]);
    assert.equal(input.value, "");
  });

  it("a denial carries the reason; ⌘/Ctrl+Enter in the reason denies", async () => {
    render(card());
    clock = START + 60_000;
    const open = Array.from(dom.window.document.querySelectorAll("button")).find((button) => button.textContent === "Deny with a reason…");
    assert.ok(open);
    act(() => open.click());
    const reason = mount.querySelector("textarea");
    assert.ok(reason);
    assert.equal(dom.window.document.activeElement, reason, "focus follows the pressed toggle into the field that replaced it");
    type(reason, "Not on this machine");
    key(reason, { key: "Enter", ctrlKey: true });
    await flush();
    assert.deepEqual(answers, [{ decision: "deny", reason: "Not on this machine" }]);
  });

  it("View all on a cut summary fetches the whole preview and shows it", async () => {
    full = card({ sections: [{ kind: "text", text: "the whole text" }, { kind: "file", path: "x.bin", size: 1, sha256: "aa", flag: "binary" }] });
    render(card({ fullPreview: true, sections: [{ kind: "text", text: "the who", partial: true }] }));
    act(() => q<HTMLButtonElement>("[data-view-all]").click());
    await flush();
    await flush();
    assert.equal(loads, 1);
    assert.match(mount.innerHTML, /the whole text/);
    assert.match(mount.innerHTML, /data-file-flag="binary"/);
  });

  it("the grant menu approves with exactly the grant it offers", async () => {
    render(card({ grantOptions: ["project"] }));
    act(() => q<HTMLButtonElement>("[data-grant-menu]").click());
    const rows = dom.window.document.querySelectorAll("[data-grant]");
    assert.deepEqual(Array.from(rows).map((row) => row.getAttribute("data-grant")), ["project"]);
    act(() => (rows[0] as HTMLButtonElement).click());
    await flush();
    assert.deepEqual(answers, [{ decision: "approve", grant: "project" }]);
  });

  it("a cut preview keeps Approve disabled until View all loaded the whole preview", async () => {
    clock = START + 60_000;
    full = card({ sections: [{ kind: "text", text: "the whole text" }] });
    render(card({ fullPreview: true, sections: [{ kind: "text", text: "the who", partial: true }] }));
    const approve = q<HTMLButtonElement>("[data-approve]");
    assert.equal(approve.disabled, true);
    assert.match(approve.title, /View all/);
    key(q('[data-tool-approval="ap-1"]'), { key: "Enter", ctrlKey: true });
    await flush();
    assert.equal(answers.length, 0, "the keyboard chord cannot bypass it");
    act(() => q<HTMLButtonElement>("[data-view-all]").click());
    await flush();
    await flush();
    assert.equal(q<HTMLButtonElement>("[data-approve]").disabled, false);
  });

  it("on a phone, opening the review sheet loads the cut preview and only then enables Approve", async () => {
    clock = START + 60_000;
    full = card({ sections: [{ kind: "text", text: "the whole text" }] });
    render(card({ fullPreview: true, sections: [{ kind: "text", text: "the who", partial: true }] }), true);
    assert.equal(q<HTMLButtonElement>("[data-approve]").disabled, true);
    act(() => q<HTMLButtonElement>("[data-review-preview]").click());
    await flush();
    await flush();
    assert.equal(loads, 1);
    assert.match(dom.window.document.body.innerHTML, /the whole text/);
    assert.equal(q<HTMLButtonElement>("[data-approve]").disabled, false);
  });

  it("a double click never approves the card that replaces the answered one", async () => {
    clock = START;
    render(card());
    clock = START + 5_000;
    pointerClick(q("[data-approve]"), 1);
    await flush();
    assert.deepEqual(answers, [{ decision: "approve" }]);
    // The next card mounts under the pointer; the double click's second click lands on it.
    render(card({ approvalId: "ap-2", title: "Claude wants to open another desktop" }));
    pointerClick(q("[data-approve]"), 2);
    await flush();
    assert.equal(answers.length, 1, "the second click is ignored");
    // A deliberate click after the pointer guard approves.
    clock = START + 5_000 + 800;
    pointerClick(q("[data-approve]"), 1);
    await flush();
    assert.equal(answers.length, 2);
  });

  it("a grant row ignores a pointer click inside the guard too", async () => {
    clock = START;
    render(card({ grantOptions: ["chat"] }));
    act(() => q<HTMLButtonElement>("[data-grant-menu]").click());
    pointerClick(q('[data-grant="chat"]'), 1);
    await flush();
    assert.equal(answers.length, 0);
  });
});
