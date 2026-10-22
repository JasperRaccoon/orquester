// The service worker's asset trimming, run in a VM against fake caches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

/** A Cache Storage holding Request-like keys in insertion order. */
function fakeCaches() {
  const stores = new Map();
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      match: async (key) => {
        const body = entries.get(new URL(typeof key === "string" ? key : key.url, "https://orq.example.com").href);
        return body === undefined ? undefined : { text: async () => body };
      },
      put: async (key, body) => {
        entries.set(new URL(typeof key === "string" ? key : key.url, "https://orq.example.com").href, body);
      },
      delete: async (key) => entries.delete(key.url)
    };
  };
  return { open: async (name) => open(name), stores, openSync: open };
}

function worker() {
  const caches = fakeCaches();
  const listeners = {};
  const context = {
    self: {
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
      location: { origin: "https://orq.example.com" }
    },
    caches,
    URL,
    Promise,
    Response: {}
  };
  vm.runInNewContext(source, context);
  return { context, caches, listeners };
}

describe("the asset cache", () => {
  it("trims the oldest assets past the limit but never the shell's own", async () => {
    const { context, caches } = worker();
    const shell = caches.openSync("orq-shell-v6");
    await shell.put(
      "/index.html",
      '<script type="module" crossorigin src="/assets/index-AAA.js"></script>' +
        '<link rel="modulepreload" crossorigin href="/assets/vendor-BBB.js">' +
        '<link rel="stylesheet" crossorigin href="/assets/index-CCC.css">'
    );
    const assets = caches.openSync("orq-assets-v6");
    // The entry bundle was cached first, so it is the oldest; then a burst of lazy chunks.
    for (const name of ["index-AAA.js", "vendor-BBB.js", "index-CCC.css"]) await assets.put(`/assets/${name}`, "x");
    for (let index = 0; index < 10; index += 1) await assets.put(`/assets/mermaid-chunk-${index}.js`, "x");
    await context.trimCache("orq-assets-v6", 5);
    const left = (await assets.keys()).map((key) => new URL(key.url).pathname);
    assert.deepEqual(left, [
      "/assets/index-AAA.js",
      "/assets/vendor-BBB.js",
      "/assets/index-CCC.css",
      "/assets/mermaid-chunk-8.js",
      "/assets/mermaid-chunk-9.js"
    ]);
  });

  it("without a cached shell, trims oldest first as before", async () => {
    const { context, caches } = worker();
    const assets = caches.openSync("orq-assets-v6");
    for (let index = 0; index < 4; index += 1) await assets.put(`/assets/chunk-${index}.js`, "x");
    await context.trimCache("orq-assets-v6", 2);
    const left = (await assets.keys()).map((key) => new URL(key.url).pathname);
    assert.deepEqual(left, ["/assets/chunk-2.js", "/assets/chunk-3.js"]);
  });

  it("does not read the shell while the cache is under the limit", async () => {
    const { context, caches } = worker();
    const assets = caches.openSync("orq-assets-v6");
    await assets.put("/assets/chunk-0.js", "x");
    const opened = [];
    const open = caches.open;
    caches.open = async (name) => {
      opened.push(name);
      return open(name);
    };
    await context.trimCache("orq-assets-v6", 2);
    assert.deepEqual(opened, ["orq-assets-v6"]);
  });

  it("has room for the lazy diagram and math chunks beside the app", () => {
    const { context } = worker();
    assert.ok(context.ASSET_CACHE_LIMIT >= 150);
  });
});

/** A value out of the worker's realm, as plain data (its objects have the VM's prototypes). */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The worker's `clients`: windows that record what they were told, and the windows opened. */
function fakeClients(count) {
  const windows = Array.from({ length: count }, () => ({
    messages: [],
    focused: 0,
    postMessage(message) {
      this.messages.push(plain(message));
    },
    focus() {
      this.focused += 1;
      return Promise.resolve(this);
    }
  }));
  const opened = [];
  return {
    windows,
    opened,
    matchAll: async () => windows,
    openWindow: async (url) => {
      opened.push(url);
      return null;
    }
  };
}

describe("a notification's tap", () => {
  it("a session's opens that session's tab", () => {
    const { context } = worker();
    assert.deepEqual(plain(context.notificationTarget({ sessionId: "3f2c1a9e-8b7d-4c6e-9f00-112233445566" })), {
      url: "/?session=3f2c1a9e-8b7d-4c6e-9f00-112233445566",
      message: { type: "orquester:open-session", sessionId: "3f2c1a9e-8b7d-4c6e-9f00-112233445566" }
    });
  });

  it("a workflow run's opens the run, as before", () => {
    const { context } = worker();
    assert.deepEqual(plain(context.notificationTarget({ sessionId: "", workflowId: "wf-1", runId: "run 2" })), {
      url: "/?workflow=wf-1",
      message: { type: "orquester:open-workflow-run", workflowId: "wf-1", runId: null }
    });
    assert.equal(context.notificationTarget({ workflowId: "wf-1", runId: "r-2" }).url, "/?workflow=wf-1&run=r-2");
  });

  it("anything else (the test push, a malformed id) just opens the app", () => {
    const { context } = worker();
    for (const data of [{ sessionId: "" }, { sessionId: "../etc/passwd" }, { sessionId: "a&b=c" }, { sessionId: 7 }, {}, null, undefined]) {
      assert.deepEqual(plain(context.notificationTarget(data)), { url: "/", message: null }, JSON.stringify(data));
    }
  });

  it("an open window is focused and told which session to open", async () => {
    const { context } = worker();
    const clients = fakeClients(2);
    await context.openNotificationTarget(clients, context.notificationTarget({ sessionId: "s-1" }));
    assert.deepEqual(clients.windows[0].messages, [{ type: "orquester:open-session", sessionId: "s-1" }]);
    assert.equal(clients.windows[0].focused, 1);
    assert.equal(clients.windows[1].focused, 0);
    assert.deepEqual(clients.opened, []);
  });

  it("with no window open, a new one starts on the session's link", async () => {
    const { context } = worker();
    const clients = fakeClients(0);
    await context.openNotificationTarget(clients, context.notificationTarget({ sessionId: "s-1" }));
    assert.deepEqual(clients.opened, ["/?session=s-1"]);
  });

  it("the click handler closes the notification and waits for the window", async () => {
    const { context, listeners } = worker();
    const clients = fakeClients(1);
    context.self.clients = clients;
    let closed = 0;
    let waited = null;
    listeners.notificationclick({
      notification: { data: { sessionId: "s-9" }, close: () => (closed += 1) },
      waitUntil: (promise) => {
        waited = promise;
      }
    });
    assert.equal(closed, 1);
    await waited;
    assert.deepEqual(clients.windows[0].messages, [{ type: "orquester:open-session", sessionId: "s-9" }]);
  });

  it("a push keeps the session, workflow and run ids for the tap", async () => {
    const { context, listeners } = worker();
    const shown = [];
    context.self.registration = { showNotification: async (title, options) => shown.push(plain({ title, options })) };
    let waited = null;
    listeners.push({
      data: { json: () => ({ title: "Agent finished", tag: "session-s-1", sessionId: "s-1" }) },
      waitUntil: (promise) => {
        waited = promise;
      }
    });
    await waited;
    assert.deepEqual(shown[0].options.data, { sessionId: "s-1" });
    assert.equal(shown[0].options.tag, "session-s-1");
  });
});
