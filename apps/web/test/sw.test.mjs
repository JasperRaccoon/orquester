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
  const context = {
    self: { addEventListener() {}, location: { origin: "https://orq.example.com" } },
    caches,
    URL,
    Promise,
    Response: {}
  };
  vm.runInNewContext(source, context);
  return { context, caches };
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
