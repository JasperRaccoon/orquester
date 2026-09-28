import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerView } from "@orquester/api";

import {
  advancedDraft,
  hasAdvancedValues,
  initialMcpForm,
  mcpDraftFromForm,
  mcpFormOrigin,
  mcpFormSignature,
  mcpNameError,
  newSecretRow,
  parsePastedCommandLine,
  secretDrafts,
  splitCommandLine,
  validateMcpForm,
  validateSecretRows,
  type SecretRow
} from "./mcp.logic";

const STDIO: McpServerView = {
  name: "jira-cloud",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@acme/jira-mcp"],
  env: [
    { key: "JIRA_TOKEN", set: true },
    { key: "JIRA_URL", set: true }
  ],
  advanced: { startup_timeout_sec: 20, enabled_tools: ["search", "get"], experimental_x: "kept" }
};

test("splitCommandLine splits like a shell: quotes, escapes, continuations, no expansion", () => {
  assert.deepEqual(splitCommandLine("npx -y @scope/pkg"), ["npx", "-y", "@scope/pkg"]);
  assert.deepEqual(splitCommandLine(`node "my server.js" --name 'a b' c\\ d`), ["node", "my server.js", "--name", "a b", "c d"]);
  assert.deepEqual(splitCommandLine(`echo "say \\"hi\\"" '\\n'`), ["echo", 'say "hi"', "\\n"]);
  assert.deepEqual(splitCommandLine("uvx \\\n  server   --port 3"), ["uvx", "server", "--port", "3"]);
  assert.deepEqual(splitCommandLine(`a "" ''`), ["a", "", ""]);
  assert.deepEqual(splitCommandLine("run $HOME/bin"), ["run", "$HOME/bin"]);
  assert.deepEqual(splitCommandLine(`open "unterminated arg`), ["open", "unterminated arg"]);
  assert.deepEqual(splitCommandLine("   "), []);
});

test("a pasted command line becomes command + args, with leading assignments as env", () => {
  assert.deepEqual(parsePastedCommandLine("npx -y @acme/jira-mcp --stdio"), {
    command: "npx",
    args: ["-y", "@acme/jira-mcp", "--stdio"],
    env: []
  });
  assert.deepEqual(parsePastedCommandLine("API_KEY=abc DEBUG= uvx server"), {
    command: "uvx",
    args: ["server"],
    env: [
      { key: "API_KEY", value: "abc" },
      { key: "DEBUG", value: "" }
    ]
  });
  assert.equal(parsePastedCommandLine("npx"), null, "one word pastes as typed");
  assert.equal(parsePastedCommandLine("  "), null);
  assert.equal(parsePastedCommandLine("FOO=1"), null, "assignments alone are no command");
});

test("secret drafts: untouched rows keep, replaced and new rows send a value, removed rows are absent", () => {
  const rows: SecretRow[] = [
    { id: "a", key: "JIRA_TOKEN", value: "", state: "existing" },
    { id: "b", key: "JIRA_URL", value: "https://new", state: "replace" },
    { id: "c", key: " NEW_ONE ", value: "v", state: "new" },
    { id: "d", key: "", value: "", state: "new" }
  ];
  assert.deepEqual(secretDrafts(rows), [
    { key: "JIRA_TOKEN", keep: true },
    { key: "JIRA_URL", value: "https://new" },
    { key: "NEW_ONE", value: "v" }
  ]);
});

test("existing secrets are never prefilled", () => {
  const form = initialMcpForm("codex", STDIO);
  assert.deepEqual(
    form.env.map(({ key, value, state }) => ({ key, value, state })),
    [
      { key: "JIRA_TOKEN", value: "", state: "existing" },
      { key: "JIRA_URL", value: "", state: "existing" }
    ]
  );
});

test("secret rows: bad keys, duplicates (headers case-insensitively) and an empty replacement are refused", () => {
  const env = validateSecretRows("env", [
    { id: "1", key: "1BAD", value: "x", state: "new" },
    { id: "2", key: "OK", value: "x", state: "new" },
    { id: "3", key: "OK", value: "y", state: "new" },
    { id: "4", key: "", value: "orphan", state: "new" },
    { id: "5", key: "TOKEN", value: "", state: "replace" },
    { id: "6", key: "", value: "", state: "new" }
  ]);
  assert.deepEqual(Object.keys(env).sort(), ["1", "3", "4", "5"]);
  const headers = validateSecretRows("headers", [
    { id: "1", key: "Authorization", value: "", state: "existing" },
    { id: "2", key: "authorization", value: "x", state: "new" },
    { id: "3", key: "Bad Header", value: "x", state: "new" }
  ]);
  assert.deepEqual(Object.keys(headers).sort(), ["2", "3"]);
});

test("the stdio draft carries command, args, cwd and env; the http draft url and headers only", () => {
  const form = initialMcpForm("claude", STDIO);
  form.cwd = " /srv/jira ";
  form.env = [...form.env.slice(0, 1), newSecretRow("EXTRA", "1")];
  form.headers = [newSecretRow("X-Ignored", "1")];
  const draft = mcpDraftFromForm("claude", form, mcpFormOrigin(STDIO));
  assert.deepEqual(draft, {
    name: "jira-cloud",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/jira-mcp"],
    cwd: "/srv/jira",
    env: [
      { key: "JIRA_TOKEN", keep: true },
      { key: "EXTRA", value: "1" }
    ],
    advanced: { startup_timeout_sec: 20, enabled_tools: ["search", "get"], experimental_x: "kept" }
  });

  const http = initialMcpForm("claude");
  http.name = "docs";
  http.transport = "http";
  http.url = " https://mcp.example.com/mcp ";
  http.command = "ignored";
  http.headers = [newSecretRow("Authorization", "Bearer x")];
  assert.deepEqual(mcpDraftFromForm("claude", http, mcpFormOrigin()), {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [{ key: "Authorization", value: "Bearer x" }]
  });
});

test("advanced fields are coerced by type; unknown keys on disk pass through; blanks are left out", () => {
  const origin = mcpFormOrigin(STDIO);
  const values = {
    startup_timeout_sec: " 30 ",
    tool_timeout_sec: "",
    enabled_tools: "search\nget, list\n\n",
    disabled_tools: "",
    bearer_token_env_var: " TOKEN_VAR ",
    required: true
  };
  assert.deepEqual(advancedDraft("codex", values, origin), {
    experimental_x: "kept",
    startup_timeout_sec: 30,
    enabled_tools: ["search", "get", "list"],
    bearer_token_env_var: "TOKEN_VAR",
    required: true
  });
  // A switch off is sent only when the file had it.
  assert.deepEqual(advancedDraft("codex", { ...values, required: false }, mcpFormOrigin()), {
    startup_timeout_sec: 30,
    enabled_tools: ["search", "get", "list"],
    bearer_token_env_var: "TOKEN_VAR"
  });
  assert.equal(
    advancedDraft("codex", { required: false }, { name: "x", advanced: { required: true } }).required,
    false
  );
});

test("the advanced form reads lists and numbers from the view, and opens when anything is set", () => {
  const form = initialMcpForm("codex", STDIO);
  assert.equal(form.advanced.startup_timeout_sec, "20");
  assert.equal(form.advanced.enabled_tools, "search\nget");
  assert.equal(form.advanced.required, false);
  assert.equal(hasAdvancedValues("codex", form), true);
  assert.equal(hasAdvancedValues("codex", initialMcpForm("codex")), false);
});

test("names follow the strictest CLI's rule", () => {
  assert.equal(mcpNameError("jira-cloud"), undefined);
  assert.equal(mcpNameError("_private"), undefined);
  assert.ok(mcpNameError(""));
  assert.ok(mcpNameError("1abc"));
  assert.ok(mcpNameError("trailing_"));
  assert.ok(mcpNameError("has space"));
  assert.ok(mcpNameError("x".repeat(65)));
});

test("validation: stdio needs a command, http a real http(s) URL, numbers must parse", () => {
  const form = initialMcpForm("codex");
  form.name = "s";
  let result = validateMcpForm("codex", form);
  assert.equal(result.valid, false);
  assert.ok(result.errors.command);
  form.command = "npx";
  assert.equal(validateMcpForm("codex", form).valid, true);
  form.advanced.startup_timeout_sec = "soon";
  result = validateMcpForm("codex", form);
  assert.equal(result.valid, false);
  assert.ok(result.errors.advanced.startup_timeout_sec);
  form.advanced.startup_timeout_sec = "";
  form.transport = "http";
  form.url = "ftp://x";
  assert.ok(validateMcpForm("codex", form).errors.url);
  form.url = "https://x.example/mcp";
  assert.equal(validateMcpForm("codex", form).valid, true);
});

test("the default transport is the agent's first; a view's is kept", () => {
  assert.equal(initialMcpForm("opencode").transport, "stdio");
  assert.equal(initialMcpForm("grok", { name: "s", transport: "sse", url: "https://x" }).transport, "sse");
});

test("the signature ignores row identities", () => {
  const a = initialMcpForm("claude", STDIO);
  const b = initialMcpForm("claude", STDIO);
  assert.notEqual(a.env[0]!.id, b.env[0]!.id);
  assert.equal(mcpFormSignature(a), mcpFormSignature(b));
  b.env[0]!.state = "replace";
  assert.notEqual(mcpFormSignature(a), mcpFormSignature(b));
});
