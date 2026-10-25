import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { browserMenuEntry, vmDevtoolsNote, vmStartingText } from "./browser-tab.logic";

describe("the VM browser rules", () => {

  it("the + menu offers Browser for a Linux box project without host Chromium, never without a channel", () => {
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: false, boxKind: "linux" }), { kind: "open" });
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: false, boxKind: "linux-gpu" }), { kind: "open" });
    assert.deepEqual(browserMenuEntry({ hasChannel: false, hostChromium: true, boxKind: "linux" }), { kind: "no-channel" });
    // Host projects and macOS/Windows boxes still need the host's Chromium.
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: false, boxKind: null }), { kind: "no-chromium" });
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: false, boxKind: "macos" }), { kind: "no-chromium" });
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: true, boxKind: "windows" }), { kind: "open" });
    assert.deepEqual(browserMenuEntry({ hasChannel: true, hostChromium: true, boxKind: null }), { kind: "open" });
  });

  it("a VM tab that is starting shows the launch's step; host tabs and other states show none", () => {
    assert.ok(vmStartingText({ status: "starting", runsIn: "box" })?.trim());
    assert.equal(
      vmStartingText({ status: "starting", runsIn: "box", progress: "Installing Chromium in the VM: Unpacking chromium" }),
      "Installing Chromium in the VM: Unpacking chromium"
    );
    assert.ok(vmStartingText({ status: "starting", runsIn: "box", progress: "  " })?.trim());
    assert.equal(vmStartingText({ status: "running", runsIn: "box", progress: "stale" }), null);
    assert.equal(vmStartingText({ status: "starting", runsIn: "host" }), null);
    assert.equal(vmStartingText({ status: "starting" }), null, "an older daemon's tab is a host tab");
  });

  it("a VM tab's DevTools panel explains why it stays empty; host tabs load DevTools", () => {
    assert.match(vmDevtoolsNote({ runsIn: "box" }) ?? "", /not available for a browser that runs in the VM/);
    assert.equal(vmDevtoolsNote({ runsIn: "host" }), null);
    assert.equal(vmDevtoolsNote({}), null);
  });
});
