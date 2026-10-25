import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  frameKey,
  hasNativeWindowControls,
  parseWindowState,
  resolveInitialWindowBounds,
  windowFrameOptions
} from "./window-state";

const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
const monitorRight = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("window-state.json", () => {
  it("reads saved bounds and the maximized flag", () => {
    assert.deepEqual(parseWindowState({ bounds: { x: 10, y: 20, width: 1400, height: 900 }, maximized: true }), {
      bounds: { x: 10, y: 20, width: 1400, height: 900 },
      maximized: true
    });
  });

  it("keeps negative saved positions for a display left of the primary", () => {
    assert.deepEqual(parseWindowState({ bounds: { x: -1500, y: -40, width: 1400, height: 900 } }), {
      bounds: { x: -1500, y: -40, width: 1400, height: 900 },
      maximized: false
    });
  });

  it("degrades a file from another version, or garbage, to the defaults field by field", () => {
    for (const raw of [null, "x", 3, [], {}]) assert.deepEqual(parseWindowState(raw), { bounds: null, maximized: false });
    assert.deepEqual(parseWindowState({ bounds: { x: 1.5, y: 0, width: 1400, height: 900 }, maximized: true }), {
      bounds: null,
      maximized: true
    });
    for (const bounds of [
      { x: 0, y: 0, width: "1400", height: 900 },
      { x: 0, y: 0, width: 0, height: 900 },
      { x: 0, y: 0, width: 1400 },
      { x: Number.NaN, y: 0, width: 1400, height: 900 },
      [0, 0, 1400, 900]
    ]) {
      assert.equal(parseWindowState({ bounds }).bounds, null, JSON.stringify(bounds));
    }
    assert.equal(parseWindowState({ maximized: "yes" }).maximized, false);
  });

});

describe("where the window opens", () => {
  it("restores bounds that fit on any connected display", () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000 };
    assert.deepEqual(resolveInitialWindowBounds(saved, [laptop, monitorRight]), saved);
    assert.deepEqual(resolveInitialWindowBounds({ x: 100, y: 50, width: 1400, height: 900 }, [laptop]), {
      x: 100,
      y: 50,
      width: 1400,
      height: 900
    });
  });

  it("centres the saved size on the primary display when its monitor is gone", () => {
    assert.deepEqual(resolveInitialWindowBounds({ x: 2000, y: 100, width: 1600, height: 1000 }, [laptop]), {
      width: 1600,
      height: 1000
    });
  });

  it("falls back to the default size when the saved one fits nowhere, nothing was saved, or no display is known", () => {
    for (const [saved, displays] of [
      [{ x: 2000, y: 0, width: 2500, height: 1400 }, [laptop]],
      [null, [laptop]],
      [{ x: 0, y: 0, width: 1400, height: 900 }, []]
    ] as const) {
      const bounds = resolveInitialWindowBounds(saved, displays);
      assert.equal("x" in bounds, false, "Electron must centre a window with no usable saved position");
      assert.equal("y" in bounds, false);
      assert.ok(bounds.width > 0 && bounds.height > 0);
    }
    // Straddling two displays fits neither: re-centred at its size.
    assert.deepEqual(resolveInitialWindowBounds({ x: 1500, y: 0, width: 1400, height: 900 }, [laptop, monitorRight]), {
      width: 1400,
      height: 900
    });
  });
});

describe("the window frame", () => {
  it("keeps macOS's hidden titlebar with traffic lights whatever the setting", () => {
    const on = windowFrameOptions("darwin", true);
    const off = windowFrameOptions("darwin", false);
    assert.equal(on.frame, false);
    assert.equal(on.titleBarStyle, "hidden");
    assert.equal(frameKey(on), frameKey(off));
    assert.equal(hasNativeWindowControls("darwin", true), true);
    assert.equal(hasNativeWindowControls("darwin", false), true);
  });

  it("gives Windows and Linux the OS frame and its buttons when the custom titlebar is off", () => {
    for (const platform of ["win32", "linux"] as const) {
      assert.deepEqual(windowFrameOptions(platform, true), { frame: false, titleBarStyle: "hidden" });
      assert.deepEqual(windowFrameOptions(platform, false), { frame: true });
      assert.notEqual(frameKey(windowFrameOptions(platform, true)), frameKey(windowFrameOptions(platform, false)));
      assert.equal(hasNativeWindowControls(platform, true), false);
      assert.equal(hasNativeWindowControls(platform, false), true);
    }
  });
});
