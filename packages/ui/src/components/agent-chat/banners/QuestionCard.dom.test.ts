/**
 * The question card, mounted: the question is markdown, option labels wrap
 * instead of truncating, the free-text answer is a multi-line field (Enter
 * answers, Shift+Enter is a newline, an IME's Enter commits), a digit typed
 * into it stays text, the preview pane follows the option being looked at, an
 * HTML preview is framed in an empty sandbox and never enters the page, and
 * the dock resolves workspace images and file links the way the timeline does.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { PendingUserInput, UserInputQuestion } from "@orquester/api/agent-chat";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use
// (a text field's `onChange` needs the `input` event).
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let QuestionCard: typeof import("./QuestionCard").QuestionCard;
let ChatBannerDock: typeof import("./ChatBannerDock").ChatBannerDock;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;
let visualSnippetDocument: typeof import("../visual/VisualSnippet").visualSnippetDocument;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "Event",
  "getComputedStyle"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  // The dock's one breakpoint: a desktop viewport.
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = (dom.window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      value: typeof value === "function" && name === "getComputedStyle" ? value.bind(dom.window) : value,
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ QuestionCard } = await import("./QuestionCard"));
  ({ ChatBannerDock } = await import("./ChatBannerDock"));
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
  ({ visualSnippetDocument } = await import("../visual/VisualSnippet"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function question(overrides: Partial<UserInputQuestion> = {}): UserInputQuestion {
  return {
    id: "Which one?",
    header: "Choice",
    question: "Which one?",
    options: [
      { label: "Alpha", description: "the first" },
      { label: "Beta", description: "the second" }
    ],
    ...overrides
  };
}

function request(...questions: UserInputQuestion[]): PendingUserInput {
  return {
    requestId: "req-1",
    createdAt: "2026-10-20T10:00:00.000Z",
    dismissible: false,
    questions: questions.length > 0 ? questions : [question()]
  };
}

let mount: HTMLDivElement;
let composer: HTMLTextAreaElement;
let root: Root;
let submitted: Array<Record<string, string | string[]>>;

function render(input: PendingUserInput, extra: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      createElement(QuestionCard, {
        request: input,
        isResponding: false,
        attachments: {},
        onSubmit: ({ answers }) => {
          submitted.push(answers);
        },
        onDismiss: null,
        onCarryTextToDraft: () => {},
        active: true,
        ...extra
      })
    );
  });
}

function q<T extends Element>(selector: string): T {
  const element = dom.window.document.querySelector<T>(selector);
  assert.ok(element, selector);
  return element;
}

function all<T extends Element>(selector: string): T[] {
  return Array.from(dom.window.document.querySelectorAll<T>(selector));
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    input instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function focus(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const preview = (): HTMLElement => q<HTMLElement>("[data-question-preview]");

beforeEach(() => {
  const document = dom.window.document;
  mount = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.replaceChildren(composer, mount);
  root = createRoot(mount);
  submitted = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("QuestionCard — the question and its options", () => {
  it("never takes focus: the composer keeps it while a question with previews appears", () => {
    focus(composer);
    render(request(question({ options: [{ label: "A", description: "", preview: "a" }, { label: "B", description: "" }] })));
    assert.equal(dom.window.document.activeElement, composer);
  });

  it("renders the question as the chat's markdown", () => {
    render(request(question({ question: "Pick **one** of `alpha` or `beta` — see [the docs](https://example.com/docs)." })));
    assert.equal(q("strong").textContent, "one");
    assert.deepEqual(all("code").map((code) => code.textContent), ["alpha", "beta"]);
    const link = q<HTMLAnchorElement>('a[href="https://example.com/docs"]');
    assert.equal(link.textContent, "the docs");
    assert.equal(link.target, "_blank");
    assert.equal(mount.textContent?.includes("**one**"), false, "no raw markdown on screen");
  });

  it("wraps long labels and descriptions instead of truncating them, with inline markdown descriptions", () => {
    const label = "Move them (Recommended) — keep the history and the blame of every moved file intact";
    render(request(question({
      options: [
        { label, description: "Uses `git mv`, so **history stays**; slower on [huge repos](https://example.com)." },
        { label: "Copy them", description: "Fast" }
      ]
    })));
    const option = all<HTMLButtonElement>("[data-question-option]")[0]!;
    assert.equal(option.querySelector(".truncate"), null, "nothing in an option is cut off");
    assert.ok(option.textContent?.includes(label), "the whole label is there");
    assert.equal(option.querySelector("strong")?.textContent, "history stays");
    assert.equal(option.querySelector("code")?.textContent, "git mv");
    // Phrasing content only inside a button: no block, and no link that would take the click.
    assert.equal(option.querySelector("a, div, p, pre, ul, ol"), null);
  });

  it("keeps the numbered options, picks by digit, and ignores a digit typed into the answer", () => {
    // jsdom does no layout: give the card a box, as a visible tab's card has.
    const prototype = dom.window.HTMLElement.prototype as unknown as { getClientRects?: () => unknown };
    prototype.getClientRects = () => [{ width: 1, height: 1 }];
    try {
      render(request(question({ options: [
        { label: "Alpha", description: "" },
        { label: "Beta", description: "" },
        { label: "Gamma", description: "" }
      ] })));
      const textarea = q<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
      focus(textarea);
      const typed = key(textarea, { key: "2" });
      assert.equal(typed.defaultPrevented, false, "a digit typed into the field is text");
      const options = all<HTMLButtonElement>("[data-question-option]");
      assert.deepEqual(options.map((option) => option.getAttribute("aria-pressed")), ["false", "false", "false"]);
      assert.deepEqual(options.map((option) => option.textContent?.slice(-1)), ["1", "2", "3"]);

      const picked = key(dom.window.document.body, { key: "2" });
      assert.equal(picked.defaultPrevented, true);
      assert.equal(all("[data-question-option]")[1]!.getAttribute("aria-pressed"), "true");
    } finally {
      // Back to jsdom's own, inherited from `Element`.
      delete prototype.getClientRects;
    }
  });
});

describe("QuestionCard — the multi-line custom answer", () => {
  it("is a textarea: Shift+Enter is a newline, Enter answers with the line breaks kept", () => {
    render(request());
    assert.equal(all('input[type="text"]').length, 0, "no single-line field any more");
    const textarea = q<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
    type(textarea, "line one");
    const newline = key(textarea, { key: "Enter", shiftKey: true });
    assert.equal(newline.defaultPrevented, false, "the browser inserts the newline");
    assert.deepEqual(submitted, []);

    type(textarea, "line one\nline two");
    const send = key(textarea, { key: "Enter" });
    assert.equal(send.defaultPrevented, true);
    assert.deepEqual(submitted, [{ "Which one?": "line one\nline two" }]);
  });

  it("never answers on an IME composition's Enter", () => {
    render(request());
    const textarea = q<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
    type(textarea, "にほんご");
    key(textarea, { key: "Enter", isComposing: true });
    key(textarea, { key: "Enter", keyCode: 229 });
    assert.deepEqual(submitted, []);
    key(textarea, { key: "Enter" });
    assert.deepEqual(submitted, [{ "Which one?": "にほんご" }]);
  });

  it("on a phone, Return in the field is a newline; the button answers", () => {
    render(request(), { compact: true });
    act(() => {
      q<HTMLButtonElement>('button[aria-label="Write a custom answer"]').click();
    });
    const textarea = q<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
    type(textarea, "from my phone");
    assert.equal(key(textarea, { key: "Enter" }).defaultPrevented, false);
    assert.deepEqual(submitted, []);
  });

  it("an Enter on the first of two questions moves on rather than answering", () => {
    render(request(question(), question({ id: "Second?", question: "Second?" })));
    const textarea = q<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
    type(textarea, "first answer");
    key(textarea, { key: "Enter" });
    assert.deepEqual(submitted, []);
    assert.ok(mount.textContent?.includes("Second?"));
  });

  it("a secret question keeps its masked single-line field", () => {
    render(request(question({ id: "token", question: "API token", options: [], isSecret: true })));
    const input = q<HTMLInputElement>('input[aria-label="Custom answer (hidden)"]');
    assert.equal(input.type, "password");
    assert.equal(all("textarea").length, 1, "only the page's own composer textarea");
    type(input, "s3cret");
    key(input, { key: "Enter" });
    assert.deepEqual(submitted, [{ token: "s3cret" }]);
  });
});

describe("QuestionCard — the composer's send answers the question on screen", () => {
  it("answers each question in turn, then sends them all; gone once the card is", async () => {
    const { answerQuestionFromComposer } = await import("./question-composer-bridge");
    render(request(question({ id: "first" }), question({ id: "second", allowCustomAnswer: false })), {
      composerSessionId: "chat-1"
    });
    assert.deepEqual(answerQuestionFromComposer("chat-1", "Gamma, actually"), { ok: true });
    await flush();
    assert.deepEqual(submitted, [], "the first answer moved the card on");
    // The second question takes only its options: the composer's text cannot answer it.
    const refused = answerQuestionFromComposer("chat-1", "anything");
    assert.equal(refused?.ok, false);
    act(() => all<HTMLButtonElement>("[data-question-option]")[1]!.click());
    await flush();
    assert.equal(answerQuestionFromComposer("chat-2", "x"), null, "another chat's composer reaches no card");
    act(() => root.unmount());
    assert.equal(answerQuestionFromComposer("chat-1", "x"), null);
    root = createRoot(mount);
  });

  it("a single question's typed answer from the composer is submitted at once", async () => {
    const { answerQuestionFromComposer } = await import("./question-composer-bridge");
    render(request(question()), { composerSessionId: "chat-1" });
    assert.deepEqual(answerQuestionFromComposer("chat-1", "  neither  "), { ok: true });
    await flush();
    assert.deepEqual(submitted, [{ "Which one?": "neither" }]);
  });
});

describe("QuestionCard — option previews", () => {
  const withPreviews = question({
    id: "Which layout?",
    question: "Which layout?",
    options: [
      { label: "Sidebar", description: "", preview: "┌──┬─────┐\n│▤ │ main│\n└──┴─────┘", previewFormat: "markdown" },
      { label: "Top bar", description: "", preview: "## Top bar\n\n[nav] [nav] [nav]", previewFormat: "markdown" },
      { label: "None", description: "" }
    ]
  });

  it("shows no pane when no option has a preview", () => {
    render(request());
    assert.equal(all("[data-question-preview]").length, 0);
  });

  it("follows the focused option, and says so when the focused one has none", () => {
    render(request(withPreviews));
    // Nothing focused yet: the first option's preview, so the pane is never blank.
    assert.equal(preview().getAttribute("aria-label"), "Preview: Sidebar");
    assert.equal(preview().getAttribute("data-question-preview"), "markdown");
    assert.ok(preview().textContent?.includes("│▤ │ main│"));
    assert.ok(preview().querySelector(".font-mono"), "the monospace box Claude writes for");

    const options = all<HTMLButtonElement>("[data-question-option]");
    focus(options[1]!);
    assert.equal(preview().getAttribute("aria-label"), "Preview: Top bar");
    assert.equal(preview().querySelector("h2")?.textContent, "Top bar", "markdown, rendered");

    focus(options[2]!);
    assert.equal(preview().getAttribute("data-question-preview"), "none");
    assert.ok(preview().textContent?.includes("No preview for this option."));

    // The arrow keys browse the options, and the pane with them.
    key(options[2]!, { key: "ArrowUp" });
    assert.equal(dom.window.document.activeElement, options[1]);
    assert.equal(preview().getAttribute("aria-label"), "Preview: Top bar");
  });

  it("follows a pick too, and starts over on the next question", () => {
    render(request(withPreviews, question({
      id: "Then?",
      question: "Then?",
      options: [
        { label: "Dark", description: "", preview: "dark mock" },
        { label: "Light", description: "", preview: "light mock" }
      ]
    })));
    act(() => {
      all<HTMLButtonElement>("[data-question-option]")[1]!.click();
    });
    assert.equal(preview().getAttribute("aria-label"), "Preview: Top bar");
    act(() => {
      q<HTMLButtonElement>("button:not([data-question-option]):not([aria-expanded])").click();
    });
    assert.ok(mount.textContent?.includes("Then?"));
    assert.equal(preview().getAttribute("aria-label"), "Preview: Dark");
  });

  it("frames an HTML preview in an empty sandbox; its markup never enters the page", async () => {
    render(request(question({
      options: [
        { label: "Card", description: "", preview: '<b id="evil" onclick="steal()">Bold</b><script>steal()</script>', previewFormat: "html" },
        { label: "List", description: "" }
      ]
    })));
    await flush();
    assert.equal(preview().getAttribute("data-question-preview"), "html");
    const frame = q<HTMLIFrameElement>("iframe[data-visual-snippet]");
    assert.equal(frame.getAttribute("sandbox"), "", "no scripts, forms, popups or same-origin");
    assert.ok(frame.getAttribute("src")?.startsWith("blob:"), "a blob: document, never srcdoc");
    assert.equal(frame.hasAttribute("srcdoc"), false);
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(frame.title, "Preview of Card");
    assert.equal(dom.window.document.getElementById("evil"), null);
    assert.equal(mount.querySelector("script"), null);
  });

  it("builds the framed document with a CSP that refuses every fetch, and the theme's tokens", () => {
    const page = visualSnippetDocument("<p>Hi</p>", {
      appearance: "dark",
      variables: { "--background": "#111", "--foreground": "#eee</style><script>x()</script>", "bad key": "1" }
    });
    assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">/);
    assert.match(page, /color-scheme:dark;--background:#111;/);
    assert.doesNotMatch(page, /<\/style><script>/, "a token cannot close the style element");
    assert.doesNotMatch(page, /bad key/);
    assert.match(page, /<body><p>Hi<\/p><\/body>/);
  });
});

describe("ChatBannerDock — the question's markdown resolves like the timeline's", () => {
  it("reads a relative image through the file API against the project, and opens a file link in a tab", async () => {
    const reads: string[] = [];
    const opened: string[] = [];
    const api = {
      readFileBytes: async (path: string) => {
        reads.push(path);
        return new ArrayBuffer(8);
      }
    };
    const noop = (): void => {};
    act(() => {
      root.render(
        createElement(OrquesterProvider, {
          // Only the file read is reached: the image goes through `useApi().readFileBytes`.
          runtime: {} as never,
          useTitlebar: false,
          api: api as never,
          children: createElement(ChatBannerDock, {
            sessionId: "s1",
            approvals: [],
            userInputs: [request(question({ question: "See ![the shot](shots/a.png) and [the notes](docs/notes.md)." }))],
            respondingRequestIds: [],
            backgroundLiveness: null,
            liveAgentCount: 0,
            stopping: false,
            actionableProposedPlan: false,
            onApprove: noop,
            onAnswer: noop,
            onDismiss: noop,
            onStopBackgroundWork: noop,
            onCarryTextToDraft: noop,
            toolApprovals: [],
            projectPath: "/work/proj",
            onOpenFile: (path: string) => {
              opened.push(path);
            }
          })
        })
      );
    });
    await flush();
    assert.deepEqual(reads, ["/work/proj/shots/a.png"]);
    const link = all<HTMLButtonElement>("button").find((button) => button.textContent === "the notes");
    assert.ok(link, "a workspace link is a button that opens the file");
    act(() => link.click());
    assert.deepEqual(opened, ["docs/notes.md"]);
  });
});
