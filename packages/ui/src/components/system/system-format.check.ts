import assert from "node:assert/strict";
import { killErrorCode } from "./system-format";

// Refusal codes are read off the ApiError body, duck-typed.
assert.equal(killErrorCode({ body: { code: "PROCESS_PROTECTED" } }), "PROCESS_PROTECTED");
assert.equal(killErrorCode({ body: { code: "PROCESS_NOT_MANAGED" } }), "PROCESS_NOT_MANAGED");
assert.equal(killErrorCode({ body: { code: "INVALID_PID" } }), "INVALID_PID");
assert.equal(killErrorCode({ body: { code: "UNSUPPORTED_PLATFORM" } }), "UNSUPPORTED_PLATFORM");
assert.equal(killErrorCode({ body: { code: "SOMETHING_ELSE" } }), null);
assert.equal(killErrorCode(new Error("network down")), null);
assert.equal(killErrorCode(null), null);
assert.equal(killErrorCode(undefined), null);

console.log("system-format.check.ts OK");
