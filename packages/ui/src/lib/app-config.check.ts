import assert from "node:assert/strict";
import { usageAgentEnabled, usagePrefsSchema } from "@orquester/config";
import { normalizeUsagePrefs } from "./app-config";

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

console.log("app-config.check OK");
