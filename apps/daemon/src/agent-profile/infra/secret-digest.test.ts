import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretDigester } from "./secret-digest.ts";

test("deepMasked hides every secret spelling at any depth and keeps everything else", () => {
  const digester = new SecretDigester();
  const server = {
    type: "remote",
    url: "https://mcp.example/mcp",
    environment: { JIRA_API_TOKEN: "ATATT-live-token" },
    env: { K: "v1" },
    http_headers: { Authorization: "Bearer abc" },
    headers: { "X-Key": "k" },
    oauth: { clientId: "public-id", clientSecret: "s3cret" },
    nested: [{ password: "hunter2" }]
  };
  const masked = JSON.stringify(digester.deepMasked(server));
  for (const secret of ["ATATT-live-token", "v1", "Bearer abc", '"k"', "s3cret", "hunter2"]) {
    assert.equal(masked.includes(secret), false, `${secret} must not survive`);
  }
  for (const kept of ["https://mcp.example/mcp", "public-id", "JIRA_API_TOKEN", "Authorization"]) {
    assert.equal(masked.includes(kept), true, `${kept} is not secret`);
  }
});

test("a changed secret still moves the digest; the same one does not", () => {
  const digester = new SecretDigester();
  const a = JSON.stringify(digester.deepMasked({ env: { K: "one" } }));
  assert.equal(JSON.stringify(digester.deepMasked({ env: { K: "one" } })), a);
  assert.notEqual(JSON.stringify(digester.deepMasked({ env: { K: "two" } })), a);
});
