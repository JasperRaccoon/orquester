import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalStorageAppConfigAdapter } from "./app-config";

const adapter = createLocalStorageAppConfigAdapter();
let value: unknown;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => key === "orquester.app" ? JSON.stringify(value) : null
} });
async function load(raw: unknown) {
  value = raw;
  return adapter.load();
}

test("stored app fields validate individually and legacy usage preferences migrate", async () => {
  // sanitizeStoredAppConfig: the localStorage blob as a whole. Valid fields pass,
  // absent fields STAY absent (so host defaults still win in the store's merge),
  // wrong-typed fields are dropped, and a legacy usage shape is migrated.
  const stored = await load({
    version: 1,
    activeConnectionId: "local",
    useTitlebar: "yes", // wrong type → dropped
    runInBackground: true,
    desktopNotifications: false,
    usage: { enabled: true, claude: false, chip: "busiest" } // legacy → migrated
  });
  assert.equal(stored.useTitlebar, undefined);
  assert.equal(stored.runInBackground, true);
  assert.equal(stored.confirmCloseSession, undefined);
  assert.equal(stored.desktopNotifications, false);
  assert.equal(stored.activeConnectionId, "local");
  assert.deepEqual(stored.usage?.agents, { claude: false });
});

test("non-object app configuration loads as empty", async () => {
  // Non-object / garbage blobs come back empty, never throw.
  assert.deepEqual(await load(null), {});
  assert.deepEqual(await load("junk"), {});
  assert.deepEqual(await load([1, 2]), {});
});

test("a corrupt usage group leaves unrelated valid app fields intact", async () => {
  // A corrupt usage sub-object is dropped while the rest survives.
  const badUsage = await load({ confirmCloseSession: false, desktopNotifications: "off", usage: { chip: "nope" } });
  assert.equal(badUsage.confirmCloseSession, false);
  assert.equal(badUsage.desktopNotifications, undefined);
  assert.equal(badUsage.usage, undefined);
});
