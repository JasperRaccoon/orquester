import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boxKindRunsBrowser, browserMenuEntry, unsandboxedTitle, vmStartingText } from "./browser-tab.logic";

describe("the VM browser rules", () => {
  it("only Linux boxes run the Browser tab's Chromium", () => {
    assert.equal(boxKindRunsBrowser("linux"), true);
    assert.equal(boxKindRunsBrowser("linux-gpu"), true);
    assert.equal(boxKindRunsBrowser("macos"), false);
    assert.equal(boxKindRunsBrowser("windows"), false);
    assert.equal(boxKindRunsBrowser("windows-gpu"), false);
    assert.equal(boxKindRunsBrowser(null), false);
  });

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
    assert.equal(vmStartingText({ status: "starting", runsIn: "box" }), "Starting Chromium in the VM…");
    assert.equal(
      vmStartingText({ status: "starting", runsIn: "box", progress: "Installing Chromium in the VM: Unpacking chromium" }),
      "Installing Chromium in the VM: Unpacking chromium"
    );
    assert.equal(vmStartingText({ status: "starting", runsIn: "box", progress: "  " }), "Starting Chromium in the VM…");
    assert.equal(vmStartingText({ status: "running", runsIn: "box", progress: "stale" }), null);
    assert.equal(vmStartingText({ status: "starting", runsIn: "host" }), null);
    assert.equal(vmStartingText({ status: "starting" }), null, "an older daemon's tab is a host tab");
  });

  it("the no-sandbox warning says where Chromium runs", () => {
    assert.equal(unsandboxedTitle("box"), "Chromium is running without its sandbox in the VM");
    assert.equal(unsandboxedTitle("host"), "Chromium is running without its sandbox on this host");
    assert.equal(unsandboxedTitle(undefined), "Chromium is running without its sandbox on this host");
  });
});
