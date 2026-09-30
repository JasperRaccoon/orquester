import assert from "node:assert/strict";
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

// sanitizeStoredAppConfig: the localStorage blob as a whole. Valid fields pass,
// absent fields STAY absent (so host defaults still win in the store's merge),
// wrong-typed fields are dropped, and a legacy usage shape is migrated.
const stored = await load({
  version: 1,
  activeConnectionId: "local",
  useTitlebar: "yes", // wrong type → dropped
  runInBackground: true,
  usage: { enabled: true, claude: false, chip: "busiest" } // legacy → migrated
});
assert.equal(stored.useTitlebar, undefined);
assert.equal(stored.runInBackground, true);
assert.equal(stored.confirmCloseSession, undefined);
assert.equal(stored.activeConnectionId, "local");
assert.deepEqual(stored.usage?.agents, { claude: false });

// Non-object / garbage blobs come back empty, never throw.
assert.deepEqual(await load(null), {});
assert.deepEqual(await load("junk"), {});
assert.deepEqual(await load([1, 2]), {});
// A corrupt usage sub-object is dropped while the rest survives.
const badUsage = await load({ confirmCloseSession: false, usage: { chip: "nope" } });
assert.equal(badUsage.confirmCloseSession, false);
assert.equal(badUsage.usage, undefined);

console.log("app-config.check OK");
