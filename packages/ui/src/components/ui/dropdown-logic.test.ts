import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DROPDOWN_DESTRUCTIVE_ATTRIBUTE,
  DROPDOWN_FOCUSABLE,
  dropdownDismissSubscription,
  dropdownFocusTarget,
  dropdownHorizontalPosition,
  dropdownPanelAttributes,
  dropdownPanelMaxWidth
} from "./dropdown-logic";

const MARGIN = 8;

describe("the panel's horizontal position (fix round 1: never clipped sideways)", () => {
  it("a panel that fits keeps its anchor exactly as before", () => {
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "right",
        triggerLeft: 900,
        triggerRight: 1000,
        viewportWidth: 1280,
        panelWidth: 288,
        margin: MARGIN
      }),
      { right: 280 },
      "right-aligned: the panel's right edge on the trigger's"
    );
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "left",
        triggerLeft: 100,
        triggerRight: 150,
        viewportWidth: 1280,
        panelWidth: 224,
        margin: MARGIN
      }),
      { left: 100 },
      "left-aligned: the panel's left edge on the trigger's"
    );
  });

  it("before the panel is measured it takes the anchor — the measurement corrects it before paint", () => {
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "right",
        triggerLeft: 150,
        triggerRight: 200,
        viewportWidth: 360,
        panelWidth: null,
        margin: MARGIN
      }),
      { right: 160 }
    );
  });

  it("the goal popover on a 360px phone: a right-aligned panel that would leave the left edge is pulled inside", () => {
    // `w-72` (288px) right-aligned under a chip whose right edge is at 200px
    // would start at -88px.
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "right",
        triggerLeft: 150,
        triggerRight: 200,
        viewportWidth: 360,
        panelWidth: 288,
        margin: MARGIN
      }),
      { left: MARGIN }
    );
  });

  it("a left-aligned panel that would leave the right edge is pushed back inside", () => {
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "left",
        triggerLeft: 300,
        triggerRight: 340,
        viewportWidth: 360,
        panelWidth: 224,
        margin: MARGIN
      }),
      { left: 360 - MARGIN - 224 }
    );
  });

  it("a panel wider than the viewport pins to the margin, and its max width is the viewport less both margins", () => {
    assert.deepEqual(
      dropdownHorizontalPosition({
        align: "right",
        triggerLeft: 250,
        triggerRight: 290,
        viewportWidth: 300,
        panelWidth: 416,
        margin: MARGIN
      }),
      { left: MARGIN }
    );
    assert.equal(dropdownPanelMaxWidth(300, MARGIN), 284);
    assert.equal(dropdownPanelMaxWidth(4, MARGIN), 0, "never negative");
  });

  it("the result is always inside the viewport's margins, for any trigger and any width", () => {
    for (const viewportWidth of [320, 360, 768, 1280]) {
      for (const panelWidth of [120, 224, 288, 416]) {
        for (const triggerRight of [0, 40, 180, viewportWidth / 2, viewportWidth - 4, viewportWidth]) {
          for (const align of ["left", "right"] as const) {
            const triggerLeft = Math.max(0, triggerRight - 40);
            const position = dropdownHorizontalPosition({
              align,
              triggerLeft,
              triggerRight,
              viewportWidth,
              panelWidth,
              margin: MARGIN
            });
            const width = Math.min(panelWidth, dropdownPanelMaxWidth(viewportWidth, MARGIN));
            const left = "left" in position ? position.left : viewportWidth - position.right - width;
            const label = JSON.stringify({ viewportWidth, panelWidth, triggerRight, align });
            assert.ok(left >= MARGIN - 1e-9, `left edge clipped ${label}`);
            assert.ok(left + width <= viewportWidth - MARGIN + 1e-9, `right edge clipped ${label}`);
          }
        }
      }
    }
  });
});

describe("the panel's role and focus (fix round 1)", () => {
  it("is a menu by default, exactly as before — no label, not focusable itself", () => {
    assert.deepEqual(dropdownPanelAttributes({}), { role: "menu" });
  });

  it("a readout with plain buttons is a labelled dialog, focusable itself when it has no control", () => {
    assert.deepEqual(dropdownPanelAttributes({ role: "dialog", ariaLabel: "Goal", focusOnOpen: true }), {
      role: "dialog",
      "aria-label": "Goal",
      tabIndex: -1
    });
  });

  it("focus lands on the panel's first control, or on the panel itself when it has none", () => {
    // Stand-ins for the DOM (there is none under node): only `querySelector`
    // is read.
    const action = { hasAttribute: () => false } as unknown as HTMLElement;
    const withAction = {
      querySelector: (selector: string) => (selector === DROPDOWN_FOCUSABLE ? action : null)
    } as unknown as HTMLElement;
    assert.equal(dropdownFocusTarget(withAction), action);
    const readout = { querySelector: () => null } as unknown as HTMLElement;
    assert.equal(dropdownFocusTarget(readout), readout);
  });

  it("fix round 2: never auto-focuses a destructive control — the panel takes focus instead", () => {
    // The goal popover whose only action is "Clear goal": focused on open, the
    // keyboard user's next Enter would clear the goal.
    const clear = {
      hasAttribute: (name: string) => name === DROPDOWN_DESTRUCTIVE_ATTRIBUTE
    } as unknown as HTMLElement;
    const panel = {
      querySelector: (selector: string) => (selector === DROPDOWN_FOCUSABLE ? clear : null)
    } as unknown as HTMLElement;
    assert.equal(dropdownFocusTarget(panel), panel);
    assert.equal(DROPDOWN_DESTRUCTIVE_ATTRIBUTE, "data-destructive");
  });

  it("only enabled, reachable controls count as the first one", () => {
    assert.match(DROPDOWN_FOCUSABLE, /button:not\(\[disabled\]\)/);
    assert.match(DROPDOWN_FOCUSABLE, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
  });
});

describe("final wave (2): an open panel closes when what it belongs to goes away", () => {
  /**
   * A stand-in for a caller's `dismissOn` — e.g. `dismissWhenChatTabLeaves`
   * (`lib/agent-chat-active-tab.ts`): records listeners, and `fire` plays the
   * panel's own tab being left.
   */
  const fakeTabSwitch = () => {
    const listeners = new Set<() => void>();
    return {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fire: () => listeners.forEach((listener) => listener()),
      size: () => listeners.size
    };
  };

  it("an open panel subscribes, and the event dismisses it", () => {
    const tabs = fakeTabSwitch();
    let dismissed = 0;
    const unsubscribe = dropdownDismissSubscription(true, tabs.subscribe, () => {
      dismissed += 1;
    });
    assert.equal(tabs.size(), 1);
    tabs.fire();
    assert.equal(dismissed, 1, "a tab switch closes it");
    unsubscribe?.();
    assert.equal(tabs.size(), 0, "closing or unmounting unsubscribes");
  });

  it("a closed panel, or one with nothing to watch, subscribes to nothing", () => {
    const tabs = fakeTabSwitch();
    assert.equal(dropdownDismissSubscription(false, tabs.subscribe, () => undefined), undefined);
    assert.equal(tabs.size(), 0);
    assert.equal(dropdownDismissSubscription(true, undefined, () => undefined), undefined);
  });
});
