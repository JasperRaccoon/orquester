import assert from "node:assert/strict";
import test from "node:test";
import { AcpRpcError, acpFailureReason } from "./errors.ts";

const rpc = (code: number, message: string, data?: unknown) => new AcpRpcError("session/prompt", { code, message, ...(data !== undefined ? { data } : {}) });

test("acpFailureReason: the codes first, then the CLI's own words on an RPC error only", () => {
  assert.equal(acpFailureReason(rpc(-32000, "whatever")), "auth");
  assert.equal(acpFailureReason(rpc(-32003, "whatever")), "usage_limit");
  assert.equal(acpFailureReason(rpc(-32603, "Internal error", "You are not authenticated.")), "auth", "read in data too");
  assert.equal(acpFailureReason(rpc(-32603, "token refresh failed: invalid_grant")), "auth");
  assert.equal(acpFailureReason(rpc(-32603, "HTTP 429: grok-usage-exhausted")), "usage_limit");
  assert.equal(acpFailureReason(rpc(-32603, "Internal error", { reason: "path not found" })), undefined);
  assert.equal(acpFailureReason(new Error("You are not authenticated.")), undefined, "never a non-RPC error");
});

test("the auth wording: the CLI's sentences, not a tool's or an MCP server's noise", () => {
  for (const text of ["You are not authenticated.", "not logged in", "authentication_failed", "Authentication required", "401 Unauthorized", "Run `grok login` to sign in", "access token has expired"]) {
    assert.equal(acpFailureReason(rpc(-32603, text)), "auth", text);
  }
  for (const text of ["Transport channel closed, when AuthRequired(stripe)", "authenticated as jasper", "permission denied"]) {
    assert.equal(acpFailureReason(rpc(-32603, text)), undefined, text);
  }
  assert.equal(acpFailureReason(rpc(-32603, "rate limit reached")), "usage_limit");
  assert.equal(acpFailureReason(rpc(-32603, "Too Many Requests")), "usage_limit");
  assert.equal(acpFailureReason(rpc(-32603, "unlimited")), undefined);
});
