import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { AgentProfileError } from "../errors.ts";
import {
  CLI_ERROR_DETAIL_MAX,
  buildAgentCliEnv,
  redactCliOutput,
  runAgentCli,
  runAgentCliOrThrow
} from "./cli-runner.ts";

/**
 * A fake agent CLI: `#!/usr/bin/env node` plus `body`, executable. It gets
 * `process.argv.slice(2)` as `args`.
 */
async function fakeCli(t: test.TestContext, body: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-cli-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-agent");
  await writeFile(bin, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

/** Sets process env vars for one test; restored after it. */
function withProcessEnv(t: test.TestContext, vars: Record<string, string>): void {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("exit code, stdout and stderr come back; argv reaches the CLI verbatim with no shell", async (t) => {
  const bin = await fakeCli(
    t,
    `process.stdout.write(JSON.stringify(args)); process.stderr.write("warn\\n"); process.exit(Number(args[0]));`
  );
  const tricky = ["3", "$(whoami)", "a b; rm -rf /", "'\"`"];
  const result = await runAgentCli({ bin, args: tricky, timeoutMs: 10_000 });
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), tricky);
  assert.equal(result.stderr, "warn\n");

  const ok = await runAgentCli({ bin, args: ["0"], timeoutMs: 10_000 });
  assert.equal(ok.code, 0);
});

test("input is fed to stdin; without input stdin is empty", async (t) => {
  const bin = await fakeCli(
    t,
    `let data = ""; process.stdin.on("data", (c) => (data += c)); process.stdin.on("end", () => process.stdout.write("[" + data + "]"));`
  );
  assert.equal((await runAgentCli({ bin, args: [], timeoutMs: 10_000, input: "hello\n" })).stdout, "[hello\n]");
  assert.equal((await runAgentCli({ bin, args: [], timeoutMs: 10_000 })).stdout, "[]");
});

test("the child's env is built explicitly: agent homes, ORQUESTER_* and NODE_OPTIONS never leak", async (t) => {
  withProcessEnv(t, {
    ORQUESTER_HTTP_PASSWORD: "hunter2-secret",
    CLAUDE_CONFIG_DIR: "/somewhere/.claude-account",
    CODEX_HOME: "/somewhere/.codex-account",
    GROK_HOME: "/somewhere/.grok-account",
    OPENCODE_CONFIG_DIR: "/somewhere/.opencode-account",
    NODE_OPTIONS: "--no-warnings",
    SOME_RANDOM_TOKEN: "abc",
    HTTPS_PROXY: "http://proxy.local:3128"
  });
  const bin = await fakeCli(t, `process.stdout.write(JSON.stringify(process.env));`);
  const result = await runAgentCli({ bin, args: [], timeoutMs: 10_000, env: { CODEX_HOME: "/var/lib/orquester/.codex" } });
  const env = JSON.parse(result.stdout) as Record<string, string>;
  for (const key of ["ORQUESTER_HTTP_PASSWORD", "CLAUDE_CONFIG_DIR", "GROK_HOME", "OPENCODE_CONFIG_DIR", "NODE_OPTIONS", "SOME_RANDOM_TOKEN"]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.CODEX_HOME, "/var/lib/orquester/.codex", "an explicit extra is passed");
  assert.equal(env.HTTPS_PROXY, "http://proxy.local:3128");
  assert.equal(env.HOME, process.env.HOME ?? homedir());
  assert.equal(env.TERM, "dumb");
  assert.equal(env.NO_COLOR, "1");
  assert.ok(env.PATH?.split(delimiter).includes(join(homedir(), ".local", "bin")), "the session PATH");
  assert.ok(env.PATH?.split(delimiter).includes(join(bin, "..")), "the bin's own dir");
});

test("buildAgentCliEnv refuses ORQUESTER_* and malformed extras", () => {
  assert.throws(() => buildAgentCliEnv({ extra: { ORQUESTER_TOKEN: "x" } }), AgentProfileError);
  assert.throws(() => buildAgentCliEnv({ extra: { "BAD NAME": "x" } }), AgentProfileError);
  assert.throws(() => buildAgentCliEnv({ extra: { OK: "a\0b" } }), AgentProfileError);
  const env = buildAgentCliEnv({}, { HOME: "/home/test", LANG: "de_DE.UTF-8", ORQUESTER_X: "no", PATH: "/usr/bin" });
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.LANG, "de_DE.UTF-8");
  assert.equal(env.ORQUESTER_X, undefined);
});

test("a deadline kills the child and says so", async (t) => {
  const bin = await fakeCli(t, `setInterval(() => {}, 1000);`);
  const result = await runAgentCli({ bin, args: [], timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
});

test("a child that ignores SIGTERM is SIGKILLed after the grace period", async (t) => {
  const bin = await fakeCli(t, `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
  const result = await runAgentCli({ bin, args: [], timeoutMs: 1500, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("output is capped per stream with a marker, and the child is still drained to its exit", async (t) => {
  const bin = await fakeCli(
    t,
    `process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(50)); process.exitCode = 0;`
  );
  const result = await runAgentCli({ bin, args: [], timeoutMs: 10_000, maxOutputBytes: 1000 });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.startsWith("x".repeat(1000)));
  assert.match(result.stdout, /\n\[output truncated at 1000 bytes\]$/);
  assert.equal(result.stdout.replace(/\n\[output truncated.*$/, "").length, 1000);
  assert.equal(result.stderr, "y".repeat(50));
});

test("runAgentCli rejects when the binary cannot be started", async () => {
  await assert.rejects(runAgentCli({ bin: "/nonexistent/agent-cli", args: [], timeoutMs: 1000 }), { code: "ENOENT" });
});

test("runAgentCliOrThrow answers on success and throws AGENT_CLI_FAILED with redacted stderr", async (t) => {
  const bin = await fakeCli(
    t,
    `if (args[0] === "ok") { process.stdout.write("done"); process.exit(0); }
     process.stderr.write([
       "Authorization: Bearer abcdefghijklmnop",
       "key sk-ant-abcdefghijklmnopqrstuvwxyz",
       "clone https://user:pa55word@example.com/repo.git",
       "API_KEY=supersecretvalue",
       "in " + require("node:os").homedir() + "/.claude/settings.json",
       "\\u001b[31mred\\u001b[0m"
     ].join("\\n"));
     process.exit(2);`
  );
  const ok = await runAgentCliOrThrow({ bin, args: ["ok"], timeoutMs: 10_000 });
  assert.equal(ok.stdout, "done");

  await assert.rejects(runAgentCliOrThrow({ bin, args: ["plugin", "install", "x"], timeoutMs: 10_000 }), (error: unknown) => {
    assert.ok(error instanceof AgentProfileError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "AGENT_CLI_FAILED");
    for (const secret of ["abcdefghijklmnop", "sk-ant-", "pa55word", "supersecretvalue", homedir() + "/", "\u001b"]) {
      assert.ok(!error.message.includes(secret), `leaked ${JSON.stringify(secret)}: ${error.message}`);
    }
    assert.match(error.message, /~\/\.claude\/settings\.json/);
    assert.match(error.message, /red/);
    return true;
  });
});

test("runAgentCliOrThrow reports deadlines, start failures and caps the detail", async (t) => {
  const slow = await fakeCli(t, `setInterval(() => {}, 1000);`);
  await assert.rejects(runAgentCliOrThrow({ bin: slow, args: ["mcp", "add"], timeoutMs: 200, label: "grok mcp add" }), {
    code: "AGENT_CLI_FAILED",
    message: /^grok mcp add failed: timed out after 0\.2 s/
  });
  await assert.rejects(runAgentCliOrThrow({ bin: "/nonexistent/claude", args: ["plugin"], timeoutMs: 1000 }), {
    code: "AGENT_CLI_FAILED"
  });
  const loud = await fakeCli(t, `process.stdout.write("z".repeat(10000)); process.exit(1);`);
  await assert.rejects(runAgentCliOrThrow({ bin: loud, args: [], timeoutMs: 10_000 }), (error: Error) => {
    const detail = error.message.slice(error.message.indexOf("failed: ") + "failed: ".length);
    assert.equal(detail.length, CLI_ERROR_DETAIL_MAX);
    assert.ok(detail.startsWith("exit code 1: zzz"), "stdout stands in for an empty stderr");
    assert.ok(detail.endsWith("…"));
    return true;
  });
});

test("redactCliOutput masks credential shapes and named secrets but keeps ordinary text", () => {
  const out = redactCliOutput(
    [
      "x-api-key: abc123",
      '"client_secret": "s3cr3t-value"',
      "password=hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "Installed plugin superpowers@claude-plugins-official (3 skills)"
    ].join("\n"),
    { homeDirs: [], literals: ["literal-secret-value"] }
  );
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("s3cr3t-value"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("ghp_abcdefghijklmnopqrstuvwxyz0123"));
  assert.match(out, /Installed plugin superpowers@claude-plugins-official \(3 skills\)/);
  assert.equal(redactCliOutput("value literal-secret-value here", { homeDirs: [], literals: ["literal-secret-value"] }), "value [redacted] here");
});
