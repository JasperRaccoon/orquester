import assert from "node:assert/strict";
import { sanitizeStoredAppConfig } from "./app-config";

// sanitizeStoredAppConfig: the localStorage blob as a whole. Valid fields pass,
// absent fields STAY absent (so host defaults still win in the store's merge),
// wrong-typed fields are dropped, and a legacy usage shape is migrated.
const stored = sanitizeStoredAppConfig({
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
assert.deepEqual(sanitizeStoredAppConfig(null), {});
assert.deepEqual(sanitizeStoredAppConfig("junk"), {});
assert.deepEqual(sanitizeStoredAppConfig([1, 2]), {});
// A corrupt usage sub-object is dropped while the rest survives.
const badUsage = sanitizeStoredAppConfig({ confirmCloseSession: false, usage: { chip: "nope" } });
assert.equal(badUsage.confirmCloseSession, false);
assert.equal(badUsage.usage, undefined);

console.log("app-config.check OK");
