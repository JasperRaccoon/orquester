// A fake `grok inspect --json` for the plugin deny-list tests.
//
// Env: FAKE_GROK_REPORT — printed as it is on stdout (default: a report naming
//   $GROK_HOME and the cwd as two plugins, so a test sees what it was given);
//   FAKE_GROK_EXIT — exit code (default 0); FAKE_GROK_HANG=1 — never exit.
//
// Run as `node fake-grok-inspect.mjs inspect --json`.

if (process.argv[2] !== "inspect" || process.argv[3] !== "--json") {
  process.stderr.write(`unexpected args: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
if (process.env.FAKE_GROK_HANG === "1") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => undefined, 1 << 30);
} else {
  const report =
    process.env.FAKE_GROK_REPORT ??
    JSON.stringify({ grokVersion: "1.0.46", plugins: [{ name: process.env.GROK_HOME }, { name: process.cwd() }] });
  process.stdout.write(report);
  const code = Number(process.env.FAKE_GROK_EXIT ?? "0");
  if (code !== 0) process.stderr.write("boom: inspect failed\n");
  process.exitCode = code;
}
