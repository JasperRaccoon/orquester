import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import type { BrowserStateMessage } from "@orquester/api";
import { BrowserManager, type BrowserChrome } from "./browsers.ts";

// subscribe() primes the canvas with one screenshot. A page still committing
// its first navigation (a VM link makes that window long) refuses it with
// "Not attached to an active page"; the tab is running and its screencast
// frames follow, so that must not put the tab in error.

/** A Chromium whose pages answer every CDP call but `Page.captureScreenshot`, which `screenshot` decides. */
function fakeChrome(screenshot: () => Promise<{ data: string }>): BrowserChrome {
  const browserEvents = new EventEmitter();
  const browser = {
    once: (event: string, listener: () => void) => browserEvents.once(event, listener),
    newPage: async () => {
      const cdp = Object.assign(new EventEmitter(), {
        send: (method: string) => (method === "Page.captureScreenshot" ? screenshot() : Promise.resolve({ currentIndex: 0, entries: [{}] }))
      });
      const page = Object.assign(new EventEmitter(), {
        browser: () => browser,
        createCDPSession: async () => cdp,
        evaluateOnNewDocument: async () => undefined,
        goto: async () => null,
        isClosed: () => false,
        mainFrame: () => null,
        title: async () => "",
        url: () => "about:blank",
        close: async () => undefined
      });
      return page;
    },
    close: async () => undefined
  };
  return {
    browser: browser as unknown as Browser,
    sandboxed: true,
    debugPort: 1,
    trustedDevtools: false,
    close: async () => undefined
  };
}

async function subscribeOnce(t: test.TestContext, screenshot: () => Promise<{ data: string }>) {
  const dir = await mkdtemp(join(tmpdir(), "orq-browsers-sub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = new BrowserManager({
    indexFile: join(dir, "browsers.json"),
    profilesDir: join(dir, "profiles"),
    resolveChromium: () => undefined,
    remoteChrome: () => ({ launch: async () => fakeChrome(screenshot) })
  });
  const tab = await manager.create("/ws/acme/app");
  const states: BrowserStateMessage[] = [];
  const frames: Buffer[] = [];
  const unsubscribe = await manager.subscribe(tab.id, {
    onFrame: (jpeg) => frames.push(jpeg),
    onState: (state) => states.push(state),
    onPicked: () => undefined,
    onEnd: () => undefined
  });
  unsubscribe();
  return { tab: manager.get(tab.id)!, states, frames };
}

test("a priming screenshot refused mid-navigation leaves the tab running, with no error", async (t) => {
  const { tab, states, frames } = await subscribeOnce(t, () => Promise.reject(new Error("Protocol error (Page.captureScreenshot): Not attached to an active page")));
  assert.equal(tab.status, "running");
  assert.equal(tab.errorMessage, undefined);
  assert.deepEqual(states.map((state) => state.status), ["running"]);
  assert.equal(frames.length, 0);
});

test("a priming screenshot that works is the first frame", async (t) => {
  const { tab, frames } = await subscribeOnce(t, async () => ({ data: Buffer.from("jpeg").toString("base64") }));
  assert.equal(tab.status, "running");
  assert.deepEqual(frames.map((frame) => frame.toString()), ["jpeg"]);
});
