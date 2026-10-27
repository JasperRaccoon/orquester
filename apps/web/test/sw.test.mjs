// Browser events run the real worker against isolated Cache Storage and clients.
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
  return {
    open: async (name) => open(name),
    containing(path) {
      const url = new URL(path, "https://orq.example.com").href;
      for (const [name, entries] of stores) if (entries.has(url)) return open(name);
      throw new Error(`No cache contains ${path}`);
    }
  };
}

function worker(globals = {}) {
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
    setTimeout,
    clearTimeout,
    Response: {},
    ...globals
  };
  vm.runInNewContext(source, context);
  return { self: context.self, caches, listeners };
}

function fetchEvent(listeners, path = "/", mode = "navigate") {
  const lifetimes = [];
  let answered;
  listeners.fetch({
    request: { url: `https://orq.example.com${path}`, method: "GET", mode },
    waitUntil: (promise) => lifetimes.push(promise),
    respondWith: (promise) => { answered = promise; }
  });
  assert.ok(answered, `the worker must answer ${path}`);
  return { answered, lifetimes };
}

describe("the asset cache", () => {
  it("evicts old assets on overflow, preserving every resource the offline shell needs", async () => {
    for (const hasShell of [true, false]) {
      const html = '<script src="/assets/index-AAA.js"></script><link href="/assets/vendor-BBB.js"><link href="/assets/index-CCC.css">';
      const { caches, listeners } = worker({ fetch: async (request) => response(request.mode === "navigate" ? html : "asset") });
      if (hasShell) {
        const navigation = fetchEvent(listeners);
        await navigation.answered;
        await Promise.all(navigation.lifetimes);
      }
      const first = fetchEvent(listeners, "/assets/index-AAA.js", "cors");
      await first.answered;
      await Promise.all(first.lifetimes);
      const assets = caches.containing("/assets/index-AAA.js");
      for (const name of ["vendor-BBB.js", "index-CCC.css"]) await assets.put(`/assets/${name}`, "asset");
      for (let index = 0; index < 200; index += 1) await assets.put(`/assets/chunk-${index}.js`, "asset");
      const overflow = fetchEvent(listeners, "/assets/latest.js", "cors");
      await overflow.answered;
      await Promise.all(overflow.lifetimes);
      assert.equal(Boolean(await assets.match("/assets/index-AAA.js")), hasShell);
      assert.equal(Boolean(await assets.match("/assets/vendor-BBB.js")), hasShell);
      assert.equal(Boolean(await assets.match("/assets/index-CCC.css")), hasShell);
      assert.equal(await assets.match("/assets/chunk-0.js"), undefined);
      assert.equal(await (await assets.match("/assets/latest.js")).text(), "asset");
      assert.ok((await assets.keys()).length <= 200);
    }
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
  it("opens the notified target, reusing an existing window or starting at its deep link", async () => {
    const { self, listeners } = worker();
    const targets = [
      [{ sessionId: "s-1" }, "/?session=s-1", { type: "orquester:open-session", sessionId: "s-1" }],
      [{ workflowId: "wf-1", runId: "r-2" }, "/?workflow=wf-1&run=r-2", { type: "orquester:open-workflow-run", workflowId: "wf-1", runId: "r-2" }],
      [{ workflowId: "wf-1", runId: "run 2" }, "/?workflow=wf-1", { type: "orquester:open-workflow-run", workflowId: "wf-1", runId: null }],
      ...[{ sessionId: "" }, { sessionId: "../etc/passwd" }, { sessionId: "a&b=c" }, { sessionId: 7 }, {}, null, undefined].map((data) => [data, "/", null])
    ];
    for (const [data, url, message] of targets) {
      for (const count of [0, 2]) {
        self.clients = fakeClients(count);
        let closed = false;
        let waited;
        listeners.notificationclick({ notification: { data, close: () => { closed = true; } }, waitUntil: (promise) => { waited = promise; } });
        assert.equal(closed, true);
        assert.ok(waited, "the notification event must keep the worker alive");
        await waited;
        assert.deepEqual(self.clients.opened, count ? [] : [url]);
        if (count) {
          assert.deepEqual(self.clients.windows[0].messages, message ? [message] : []);
          assert.equal(self.clients.windows[0].focused, 1);
          assert.equal(self.clients.windows[1].focused, 0);
        }
      }
    }
  });

  it("a push keeps the session, workflow and run ids for the tap", async () => {
    const { self, listeners } = worker();
    const shown = [];
    self.registration = { showNotification: async (title, options) => shown.push(plain({ title, options })) };
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

/** Timers the test advances by hand, and a fetch it answers by hand. */
function controlledNetwork() {
  const timers = [];
  let pending = null;
  return {
    globals: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true;
      },
      fetch: () =>
        new Promise((resolve, reject) => {
          pending = { resolve, reject };
        }),
      Response: { error: () => ({ error: true }) }
    },
    fireTimers() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    },
    answer(response) {
      pending.resolve(response);
    },
    fail() {
      pending.reject(new TypeError("Failed to fetch"));
    }
  };
}

// The fake cache stores what it is given, so the clone is the body itself.
const response = (body) => ({ ok: true, body, clone: () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a navigation on a bad link", () => {
  it("answers from the network when it comes in time, and caches the shell", async () => {
    const network = controlledNetwork();
    const { listeners, caches } = worker(network.globals);
    const event = fetchEvent(listeners);
    network.answer(response("<html>new</html>"));
    assert.equal((await event.answered).body, "<html>new</html>");
    await Promise.all(event.lifetimes);
    assert.equal(await (await caches.containing("/index.html").match("/index.html")).text(), "<html>new</html>");
  });

  it("serves the cached shell once the timeout passes, and still caches the late answer", async () => {
    const network = controlledNetwork();
    const { listeners, caches } = worker(network.globals);
    const initial = fetchEvent(listeners);
    network.answer(response("<html>old</html>"));
    await initial.answered;
    await Promise.all(initial.lifetimes);
    const event = fetchEvent(listeners);
    let result;
    const answered = event.answered.then((value) => (result = value));
    await settle();
    assert.equal(result, undefined, "nothing before the timeout");
    network.fireTimers();
    await answered;
    assert.equal(await result.text(), "<html>old</html>");
    // The network answers later: the next start gets the new shell.
    network.answer(response("<html>new</html>"));
    await Promise.all(event.lifetimes);
    assert.equal(await (await caches.containing("/index.html").match("/index.html")).text(), "<html>new</html>");
  });

  it("without a cached shell, waits on the network past the timeout", async () => {
    const network = controlledNetwork();
    const { listeners } = worker(network.globals);
    let result;
    const answered = fetchEvent(listeners).answered.then((value) => (result = value));
    network.fireTimers();
    await settle();
    assert.equal(result, undefined);
    network.answer(response("<html>slow</html>"));
    await answered;
    assert.equal(result.body, "<html>slow</html>");
  });

  it("offline, answers the cached shell, or a network error without one", async () => {
    for (const shell of ["<html>old</html>", undefined]) {
      const network = controlledNetwork();
      const { listeners } = worker(network.globals);
      if (shell) {
        const initial = fetchEvent(listeners);
        network.answer(response(shell));
        await initial.answered;
        await Promise.all(initial.lifetimes);
      }
      const { answered } = fetchEvent(listeners);
      network.fail();
      const result = await answered;
      if (shell) assert.equal(await result.text(), shell);
      else assert.deepEqual(plain(result), { error: true });
    }
  });
});
