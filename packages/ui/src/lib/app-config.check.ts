import assert from "node:assert/strict";
import { usageAgentEnabled, usagePrefsSchema } from "@orquester/config";
import { normalizeUsagePrefs, sanitizeStoredAppConfig } from "./app-config";

const fallback = usagePrefsSchema.parse({});

// Legacy pre-record shape (old web bundles persisted this to localStorage,
// bypassing the schema): no `agents` key, per-agent booleans at the top level.
// It must come back with a real `agents` record — reading it raw crashed the
// web client with "Cannot read properties of undefined (reading 'claude')".
const legacy = normalizeUsagePrefs({ enabled: true, claude: true, codex: false, chip: "busiest" }, fallback);
assert.deepEqual(legacy.agents, { claude: true, codex: false });
assert.equal(usageAgentEnabled(legacy, "claude"), true);
assert.equal(usageAgentEnabled(legacy, "codex"), false);

// Current shape passes through unchanged.
const current = normalizeUsagePrefs({ enabled: false, agents: { claude: false }, chip: "codex", view: "accounts" }, fallback);
assert.deepEqual(current, { enabled: false, agents: { claude: false }, chip: "codex", view: "accounts" });

// Garbage/absent input falls back rather than propagating a bad object.
assert.equal(normalizeUsagePrefs(undefined, fallback), fallback);
assert.equal(normalizeUsagePrefs(null, fallback), fallback);
assert.equal(normalizeUsagePrefs("nope", fallback), fallback);
assert.equal(normalizeUsagePrefs({ chip: "not-an-agent" }, fallback), fallback);

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
