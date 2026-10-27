import assert from "node:assert/strict";
import { it } from "node:test";

import { repoIdentityErrorText } from "./errors.ts";

const apiError = (status: number, body?: unknown, serverMessage: string | null = null) =>
  Object.assign(new Error(`Orquester API POST /x failed with status ${status}`), { status, body, serverMessage });

it("prefers the daemon's own message", () => {
  assert.equal(
    repoIdentityErrorText(apiError(502, { code: "FAVICON_UNREACHABLE" }, "Couldn't reach a.com (timeout)."), "a.com"),
    "Couldn't reach a.com (timeout)."
  );
});

it("maps a refusal code without a message to friendly text naming the domain", () => {
  assert.match(repoIdentityErrorText(apiError(502, { code: "FAVICON_UNREACHABLE" }), "matssmile.com"), /reach.*matssmile\.com/i);
  assert.match(repoIdentityErrorText(apiError(404, { code: "FAVICON_NOT_FOUND" }), "matssmile.com"), /no icon.*matssmile\.com/i);
  assert.match(repoIdentityErrorText(apiError(400, { code: "FAVICON_BLOCKED" }), "intranet.example"), /intranet\.example/);
  assert.match(repoIdentityErrorText(apiError(409, { code: "FAVICON_BUSY" })), /already being fetched/);
});

it("falls back on the status, then the error's message", () => {
  assert.match(repoIdentityErrorText(apiError(404)), /doesn't support repo icons/);
  assert.match(repoIdentityErrorText(apiError(500)), /500/);
  assert.equal(repoIdentityErrorText(new Error("Network down")), "Network down");
});
