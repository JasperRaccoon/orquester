/**
 * The right dock's keyboard.
 *
 * While focus is inside the dock it holds an open layer
 * (`lib/open-layers.ts`), so every listener that reads
 * `anotherLayerOwnsTheKeyboard()` stands down while the user works in a panel:
 * the chat shell's capture-phase Escape (interrupt a running turn, the Esc-Esc
 * rewind), the composer's own Escape arms, and `Ctrl+Shift+A`. The layer is
 * released the moment focus leaves the dock, and when the dock closes.
 *
 * An Escape nothing inside the dock handled then hands the keyboard back —
 * to the visible chat's composer, else by blurring (`RightRailDock`) — and
 * every other key typed in the dock stays there (`dockKeyAction`).
 */

import React from "react";

import { isAnyLayerOpen, openLayer } from "../../lib/open-layers";

/** The keydown facts `dockKeyAction` decides on (so the rules run as data). */
export interface DockKeyInput {
  key: string;
  /** Auto-repeat of a held key. */
  repeat: boolean;
  /** Something inside the dock already acted on the key (the search field clearing itself). */
  defaultPrevented: boolean;
  /** An IME composition is in progress (its Escape cancels the composition). */
  isComposing: boolean;
  /**
   * The DOM target is inside the dock. React bubbles a PORTALED child's events
   * (a dropdown panel the panel opened) through the dock too, but those keys
   * belong to that layer.
   */
  targetInsideDock: boolean;
  /**
   * Some layer OTHER than the dock's own is open — a dropdown, context menu or
   * dialog the panel opened (`otherKeyboardLayerOpen`). Called only for an
   * Escape that would otherwise leave the dock.
   */
  otherLayerOpen: () => boolean;
}

/**
 * - `leave`: hand the keyboard back to the chat (the dock's own Escape).
 * - `contain`: stop the key at the dock — document-level listeners never see
 *   it. A question card answers on a bare digit whenever focus is outside an
 *   editable field, and a focused prompt card is exactly that; an answer
 *   cannot be taken back.
 * - `ignore`: not the dock's to act on.
 */
export type DockKeyAction = "leave" | "contain" | "ignore";

export function dockKeyAction(input: DockKeyInput): DockKeyAction {
  if (!input.targetInsideDock) return "ignore";
  // Escape is the only key a layer closes on (with a `document` listener), so
  // it is the only one that must travel on.
  if (input.key !== "Escape") return "contain";
  if (input.isComposing || input.defaultPrevented) return "ignore";
  // A held Escape leaves once. Its repeats would land in the composer the
  // first press focused, where an Escape interrupts a running turn.
  if (input.repeat) return "ignore";
  // An open dropdown, menu or dialog closes on this Escape, and that is all it does.
  return input.otherLayerOpen() ? "ignore" : "leave";
}

/**
 * Is some open layer other than the dock's own open? The registry answers
 * "any", so the dock's registration is set aside for one synchronous read and
 * then taken out again — `ours.current` is left holding the new release.
 */
export function otherKeyboardLayerOpen(ours: { current: (() => void) | null }): boolean {
  const release = ours.current;
  if (release === null) return isAnyLayerOpen();
  release();
  const others = isAnyLayerOpen();
  ours.current = openLayer();
  return others;
}

/**
 * Hold the dock's keyboard layer while `held`: registered when it turns true,
 * released when it turns false and on unmount — `useOpenLayer`'s contract
 * exactly. Built on `openLayer` rather than that hook only because the
 * dock also has to ask `otherKeyboardLayerOpen`, which needs the release that
 * the hook keeps to itself. Returns that question.
 */
export function useDockKeyboardLayer(held: boolean): () => boolean {
  const ours = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    if (!held) return undefined;
    ours.current = openLayer();
    return () => {
      ours.current?.();
      ours.current = null;
    };
  }, [held]);
  return React.useCallback(() => otherKeyboardLayerOpen(ours), []);
}

/** What {@link focusFellOut} needs of the element that last had focus in the dock. */
export interface LastFocused {
  isConnected: boolean;
  matches?: (selector: string) => boolean;
  closest?: (selector: string) => unknown;
}

/**
 * Did focus fall out from under the user — the element it was on inside the
 * dock went away (removed: a card moved to the other section, a row deleted)
 * or stopped taking focus (disabled while its prompt resolves, itself or by a
 * disabled `<fieldset>` around it; hidden; made inert) — and land nowhere?
 * Then the dock takes it back (its root is focusable), so the keyboard stays
 * in the panel: on `<body>` the next bare Escape would interrupt the chat's
 * running turn. A user who clicked away left behind an element that is still
 * there and still focusable, and the dock lets go.
 */
export function focusFellOut(input: {
  /** `document.activeElement`. */
  active: Element | null;
  body: Element | null;
  /** The element inside the dock that last took focus. */
  last: LastFocused | null;
}): boolean {
  if (input.active !== null && input.active !== input.body) return false;
  const last = input.last;
  if (last === null) return false;
  if (!last.isConnected) return true;
  if (typeof last.matches === "function" && last.matches(":disabled")) return true;
  return typeof last.closest === "function" && last.closest("[inert],[hidden]") !== null;
}

/** What the focus tracker reads and drives: the dock's root and the document. */
export interface FocusTrackerEnv {
  node: LastFocused & {
    contains(other: Element): boolean;
    focus(options?: { preventScroll?: boolean }): void;
  };
  doc: { readonly activeElement: Element | null; readonly body: Element | null };
  setInside(inside: boolean): void;
  /** Run `task` once the current commit is done (`setTimeout(…, 0)`); returns its cancel. */
  defer(task: () => void): () => void;
}

export interface FocusTracker {
  /** Decide from where focus is now: a DOM change, a deferred `focusout`, the first look. */
  check(): void;
  /** A `focusin` inside the dock; `target` is the element that took focus. */
  focusIn(target: LastFocused | null): void;
  /**
   * A `focusout` from inside the dock: `true` when focus moved to another
   * element inside it, `false` when it went to one outside, `null` when it
   * went nowhere (`relatedTarget` null).
   */
  focusOut(nextInside: boolean | null): void;
  /** Cancel a pending deferred check (the dock is going away). */
  dispose(): void;
}

/**
 * The rules behind {@link useFocusInside}, over a DOM it is handed — so they
 * run as data. `last` is the element inside the dock that last had focus:
 * recorded on every `focusin` AND by any check that finds focus inside — the
 * first look included, because a field the panel focuses as it mounts does so
 * before a `focusin` listener exists, and without it that field's removal
 * would read as the user leaving.
 */
export function createFocusTracker(env: FocusTrackerEnv): FocusTracker {
  let last: LastFocused | null = null;
  let cancelDeferred: (() => void) | null = null;
  const release = (): void => {
    last = null;
    env.setInside(false);
  };
  const check = (): void => {
    const active = env.doc.activeElement;
    if (active !== null && env.node.contains(active)) {
      last = active;
      env.setInside(true);
      return;
    }
    if (focusFellOut({ active, body: env.doc.body, last })) {
      env.node.focus({ preventScroll: true });
      // The root itself may refuse focus (hidden, inert, gone): then the
      // keyboard is nobody's in here, and the layer must go. (An identity
      // check: the root is typed by what the rules read, not as an Element.)
      if ((env.doc.activeElement as unknown) === env.node) {
        last = env.node;
        env.setInside(true);
        return;
      }
    }
    release();
  };
  return {
    check,
    focusIn(target) {
      last = target;
      env.setInside(true);
    },
    focusOut(nextInside) {
      if (nextInside === true) return;
      if (nextInside === false) {
        release();
        return;
      }
      // To nowhere: a click on nothing focusable, the window losing focus, or
      // the focused element going away mid-commit. Decided once it is done.
      cancelDeferred?.();
      cancelDeferred = env.defer(() => {
        cancelDeferred = null;
        check();
      });
    },
    dispose() {
      cancelDeferred?.();
      cancelDeferred = null;
    }
  };
}

/**
 * Whether focus is inside `node` — and keeping it there when it falls out.
 *
 * `focusin`/`focusout` say when focus moves in or out. They are not the whole
 * story: a focused element that is REMOVED (a card moved or deleted) or
 * disabled drops focus to `<body>`, with a `focusout` whose `relatedTarget` is
 * null or with none anyone sees (React swallows the events a commit causes).
 * So every change to the subtree re-checks where focus is, and so does a
 * `focusout` to nowhere, once the commit that caused it is done: focus that
 * fell out from under the user comes back to the dock (`focusFellOut`), and
 * focus the user took elsewhere releases it — a layer held past that point
 * would keep the chat's Escape and `Ctrl+Shift+A` switched off with nothing on
 * screen that owns them. The first check runs as the listeners attach: a
 * panel that focuses its search field as it mounts does so before any
 * listener exists. The rules are {@link createFocusTracker}'s.
 */
export function useFocusInside(node: HTMLElement | null): boolean {
  const [inside, setInside] = React.useState(false);
  React.useEffect(() => {
    if (node === null) {
      setInside(false);
      return undefined;
    }
    const tracker = createFocusTracker({
      node,
      doc: document,
      setInside,
      defer: (task) => {
        const timer = setTimeout(task, 0);
        return () => clearTimeout(timer);
      }
    });
    const onFocusIn = (event: FocusEvent): void =>
      tracker.focusIn(event.target instanceof Element ? event.target : null);
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      tracker.focusOut(next === null ? null : next instanceof Node && node.contains(next));
    };
    tracker.check();
    node.addEventListener("focusin", onFocusIn);
    node.addEventListener("focusout", onFocusOut);
    const observer =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(() => tracker.check());
    observer?.observe(node, {
      childList: true,
      subtree: true,
      attributeFilter: ["disabled", "hidden", "inert"]
    });
    return () => {
      node.removeEventListener("focusin", onFocusIn);
      node.removeEventListener("focusout", onFocusOut);
      observer?.disconnect();
      tracker.dispose();
    };
  }, [node]);
  return inside;
}
