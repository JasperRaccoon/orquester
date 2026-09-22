/**
 * Raw-frame redaction. Grok is the one provider whose raw stream is a
 * credential sink, so this is a security test, not a formatting one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { captureFiles, readCapture } from "../fixtures.ts";
import { REDACTED, redactAcpFrame } from "./redact.ts";

test("every MCP server env value is masked before the line is written", () => {
  const frame = {
    jsonrpc: "2.0",
    method: "_x.ai/mcp/servers_updated",
    params: {
      mcpServers: [
        {
          name: "jira-cloud",
          command: "/usr/bin/node",
          env: [
            { name: "JIRA_EMAIL", value: "someone@example.com" },
            { name: "JIRA_API_TOKEN", value: "ATATT3xFfGF0abcdefghijklmnop" }
          ]
        }
      ]
    }
  };
  const redacted = JSON.stringify(redactAcpFrame(frame));
  assert.equal(redacted.includes("ATATT3xFfGF0abcdefghijklmnop"), false);
  assert.equal(redacted.includes("someone@example.com"), false);
  assert.match(redacted, new RegExp(REDACTED));
  // The structure survives, so the frame is still diagnosable.
  assert.match(redacted, /JIRA_API_TOKEN/);
  assert.match(redacted, /jira-cloud/);
});

test("credential-shaped values are masked wherever they appear", () => {
  const redacted = JSON.stringify(
    redactAcpFrame({
      result: {
        _meta: {
          email: "user@example.com",
          agentId: "ee43400e-29f2-5461-beba-192d72851a55",
          auth_mode: "Oidc"
        }
      }
    })
  );
  assert.equal(redacted.includes("user@example.com"), false);
  assert.equal(redacted.includes("ee43400e"), false, "agentId is a stable host identifier");
  assert.match(redacted, /Oidc/, "non-credential fields survive");
});

test("home paths collapse and token shapes are masked inside free text", () => {
  const redacted = JSON.stringify(
    redactAcpFrame(
      {
        params: {
          update: {
            content: {
              text: "wrote /var/lib/orquester/daemon/x with Authorization: Bearer abc.def-ghi and sk-abcdefgh1234"
            }
          }
        }
      },
      { homeDirs: ["/var/lib/orquester"] }
    )
  );
  assert.equal(redacted.includes("/var/lib/orquester"), false);
  assert.equal(redacted.includes("abc.def-ghi"), false);
  assert.equal(redacted.includes("sk-abcdefgh1234"), false);
});

test("redaction never throws, whatever it is handed", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic["self"] = cyclic;
  assert.doesNotThrow(() => redactAcpFrame(cyclic));
  assert.equal(redactAcpFrame(undefined), undefined);
  assert.equal(redactAcpFrame(7), 7);
  assert.deepEqual(redactAcpFrame([1, "a"]), [1, "a"]);
});

test("a deeply nested frame is bounded rather than walked forever", () => {
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let index = 0; index < 60; index += 1) {
    deep = { next: deep };
  }
  const redacted = JSON.stringify(redactAcpFrame(deep));
  assert.match(redacted, /depth limit/);
});

test("a long array keeps its head and says how much it dropped", () => {
  const redacted = redactAcpFrame({ items: new Array(400).fill("x") }) as { items: unknown[] };
  assert.equal(redacted.items.length, 257);
  assert.match(String(redacted.items.at(-1)), /144 more items/);
});

test("the committed captures are already redacted, and stay that way through the redactor", () => {
  for (const file of captureFiles()) {
    for (const entry of readCapture(file)) {
      const frame = entry.frame as { method?: string; params?: { mcpServers?: unknown } } | null;
      if (frame?.method !== "_x.ai/mcp/servers_updated") {
        continue;
      }
      const redacted = redactAcpFrame(frame) as {
        params: { mcpServers: Array<{ env?: Array<{ value?: unknown }> }> };
      };
      for (const server of redacted.params.mcpServers) {
        for (const pair of server.env ?? []) {
          assert.equal(pair.value, REDACTED, `${file} kept an MCP env value`);
        }
      }
    }
  }
});

test("an MCP env given as an OBJECT MAP is masked too", () => {
  // R4 #13: Grok's ACP frames use `[{name, value}]`, but `~/.claude.json` —
  // which Grok reads through its Claude-compat layer — stores the same thing
  // as an object map, and only the array spelling was recognised.
  const redacted = JSON.stringify(
    redactAcpFrame({
      method: "_x.ai/mcp/servers_updated",
      params: {
        mcpServers: [
          {
            name: "jira-cloud",
            env: { JIRA_API_TOKEN: "ATATT3xFfGF0abcdefghijklmnop", JIRA_HOST: "example.atlassian.net" }
          }
        ]
      }
    })
  );
  assert.equal(redacted.includes("ATATT3xFfGF0abcdefghijklmnop"), false);
  assert.equal(redacted.includes("example.atlassian.net"), false);
  assert.match(redacted, /JIRA_API_TOKEN/, "the key survives, the value does not");
});

test("`environment` and `envVars` are env containers too", () => {
  const redacted = redactAcpFrame({
    servers: [{ environment: { SECRET: "s3cr3t-value" } }, { envVars: [{ name: "K", value: "v" }] }]
  }) as { servers: Array<Record<string, unknown>> };
  assert.equal(JSON.stringify(redacted).includes("s3cr3t-value"), false);
  assert.equal(JSON.stringify(redacted).includes('"v"'), false);
});
