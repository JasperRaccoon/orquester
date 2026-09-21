import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_HOME_ENV_VAR,
  AMBIENT_CREDENTIAL_ENV_VARS,
  buildProviderEnv,
  needsShellExpansion
} from "./env.ts";

const base = {
  sessionPath: "/usr/local/bin:/usr/bin:/home/orq/.local/bin",
  tmpDir: "/var/lib/orquester/tmp",
  homeDir: "/var/lib/orquester",
  sessionId: "sess-1"
} as const;

test("the env is built from nothing — process.env is never spread", () => {
  process.env.ORQ_ENV_LEAK_CANARY = "leaked";
  try {
    const env = buildProviderEnv({ adapter: "codex", ...base });
    assert.equal(env.ORQ_ENV_LEAK_CANARY, undefined);
    assert.deepEqual(Object.keys(env).sort(), [
      "HOME",
      "ORQUESTER_SESSION_ID",
      "PATH",
      "TMPDIR"
    ]);
  } finally {
    delete process.env.ORQ_ENV_LEAK_CANARY;
  }
});

test("every adapter binds its account home through its own variable", () => {
  for (const [adapter, variable] of Object.entries(ACCOUNT_HOME_ENV_VAR)) {
    const env = buildProviderEnv({
      adapter: adapter as keyof typeof ACCOUNT_HOME_ENV_VAR,
      ...base,
      accountHomeDir: "/var/lib/orquester/daemon/agent-accounts/x/home"
    });
    assert.equal(env[variable], "/var/lib/orquester/daemon/agent-accounts/x/home");
  }
  // Claude binds CLAUDE_CONFIG_DIR and must NOT move HOME (§4.5).
  const claude = buildProviderEnv({
    adapter: "claude",
    ...base,
    accountHomeDir: "/accounts/claude/home"
  });
  assert.equal(claude.HOME, base.homeDir);
  assert.equal(claude.CLAUDE_CONFIG_DIR, "/accounts/claude/home");
});

test("ambient vendor credentials are stripped from extraEnv", () => {
  const env = buildProviderEnv({
    adapter: "grok",
    ...base,
    extraEnv: { XAI_API_KEY: "xai-secret", GROK_OAUTH2_REFERRER: "https://x.ai" }
  });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_OAUTH2_REFERRER, "https://x.ai");
  assert.ok(AMBIENT_CREDENTIAL_ENV_VARS.grok.includes("XAI_API_KEY"));
});

test("the cliproxy launcher may keep the one credential that IS the identity", () => {
  const env = buildProviderEnv({
    adapter: "claude",
    ...base,
    extraEnv: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "proxy-token",
      ANTHROPIC_API_KEY: "ambient-user-key"
    },
    allowCredentialVars: ["ANTHROPIC_AUTH_TOKEN"]
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "proxy-token");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8317");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "an unlisted ambient key still goes");
});

test("extraEnv can never move a child off the session PATH, TMPDIR or HOME", () => {
  const env = buildProviderEnv({
    adapter: "opencode",
    ...base,
    extraEnv: { PATH: "/nope", TMPDIR: "/tmp", HOME: "/root", OPENCODE_CONFIG_CONTENT: "{}" }
  });
  assert.equal(env.PATH, base.sessionPath);
  assert.equal(env.TMPDIR, base.tmpDir);
  assert.equal(env.HOME, base.homeDir);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, "{}");
});

test("the account binding wins over anything extraEnv sets", () => {
  const env = buildProviderEnv({
    adapter: "codex",
    ...base,
    accountHomeDir: "/accounts/codex/home",
    extraEnv: { CODEX_HOME: "/somewhere/else" }
  });
  assert.equal(env.CODEX_HOME, "/accounts/codex/home");
});

test("undefined values are dropped, never stringified", () => {
  const env = buildProviderEnv({
    adapter: "claude",
    ...base,
    extraEnv: { MAYBE: undefined, REAL: "1" }
  });
  assert.ok(!("MAYBE" in env));
  assert.equal(env.REAL, "1");
});

test("ORQUESTER_SESSION_ID is always stamped", () => {
  const env = buildProviderEnv({ adapter: "claude", ...base });
  assert.equal(env.ORQUESTER_SESSION_ID, "sess-1");
});

test("needsShellExpansion flags the values a child would receive verbatim", () => {
  assert.equal(needsShellExpansion("~/.codex_work"), true);
  assert.equal(needsShellExpansion("$HOME/.codex"), true);
  assert.equal(needsShellExpansion("/var/lib/orquester/.codex"), false);
});
