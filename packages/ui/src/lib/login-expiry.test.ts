import assert from "node:assert/strict";
import test from "node:test";
import { loginExpiryWarning } from "./login-expiry";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const expiresIn = (remaining: number) => ({ loginExpiresAt: new Date(NOW + remaining).toISOString() });

test("login warnings count down from seven days through hours and minutes", () => {
  for (const [remaining, expected] of [
    [7 * DAY + 1, null],
    [7 * DAY, "Login expires in 7 days"],
    [5 * DAY, "Login expires in 5 days"],
    [DAY, "Login expires in 1 day"],
    [20 * HOUR, "Login expires in 20 hours"],
    [HOUR, "Login expires in 1 hour"],
    [25 * MINUTE, "Login expires in 25 minutes"],
    [1, "Login expires in 1 minute"],
    [0, "Login expired, please re-login"],
    [-MINUTE, "Login expired, please re-login"]
  ] as const) {
    assert.equal(loginExpiryWarning(expiresIn(remaining), NOW), expected);
  }
  assert.equal(loginExpiryWarning(expiresIn(25 * MINUTE), NOW + 5 * MINUTE), "Login expires in 20 minutes");
});

test("failed authentication takes precedence; unknown deadlines never invent an expiry", () => {
  assert.equal(loginExpiryWarning({ ...expiresIn(30 * DAY), needsReauth: true }, NOW), "Login expired, please re-login");
  assert.equal(loginExpiryWarning({}, NOW), null);
  assert.equal(loginExpiryWarning({ loginExpiresAt: "invalid" }, NOW), null);
});
