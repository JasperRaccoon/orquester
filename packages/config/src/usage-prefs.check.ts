import assert from "node:assert/strict";
import { createDefaultAppConfig, parseAppConfig, usagePrefsSchema } from "./index";

// Defaults make the feature zero-config.
const def = createDefaultAppConfig();
assert.deepEqual(def.usage, { enabled: true, claude: true, codex: true, chip: "busiest" });

// The schema fills partial input.
assert.equal(usagePrefsSchema.parse({ enabled: false }).chip, "busiest");

// An old app.json without `usage` still parses (back-compat).
const migrated = parseAppConfig({ version: 1 });
assert.equal(migrated.usage.enabled, true);

// Invalid chip value is rejected.
assert.throws(() => usagePrefsSchema.parse({ chip: "nope" }));

console.log("usage-prefs.check OK");
