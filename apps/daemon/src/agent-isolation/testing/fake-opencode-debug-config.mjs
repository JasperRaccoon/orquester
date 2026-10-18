// A fake `opencode debug config` for the OPENCODE_TEST_HOME probe tests.
//
// Prints `{ "command": { <name>: {...} } }` with one entry per `*.md` file of
// `<home>/.opencode/command` and `<home>/.opencode/commands`, where `<home>` is
// $OPENCODE_TEST_HOME when set, else $HOME — what OpenCode 1.18.34 does.
//
// Flags (before `debug config`): --ignore-test-home (always $HOME: an OpenCode
// that does not honour the variable), --no-home-config (never reads
// `~/.opencode`), --exit=<code>, --garbage (prints non-JSON), --hang.
//
// Run as `node fake-opencode-debug-config.mjs [flags] debug config`.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const rest = args.filter((arg) => !arg.startsWith("--"));
if (rest[0] !== "debug" || rest[1] !== "config") {
  process.stderr.write(`unexpected args: ${args.join(" ")}\n`);
  process.exit(2);
}
if (flags.has("--hang")) {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => undefined, 1 << 30);
} else {
  const exit = [...flags].find((flag) => flag.startsWith("--exit="));
  if (exit !== undefined) {
    process.stderr.write("boom: config failed\n");
    process.exit(Number(exit.slice("--exit=".length)));
  }
  if (flags.has("--garbage")) {
    process.stdout.write("not json");
  } else {
    const home = flags.has("--ignore-test-home") ? process.env.HOME : (process.env.OPENCODE_TEST_HOME ?? process.env.HOME);
    const command = {};
    if (!flags.has("--no-home-config") && home) {
      for (const dir of ["command", "commands"]) {
        let names = [];
        try {
          names = readdirSync(join(home, ".opencode", dir));
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.endsWith(".md")) command[name.slice(0, -3)] = { template: "x" };
        }
      }
    }
    process.stdout.write(JSON.stringify({ $schema: "https://opencode.ai/config.json", command }));
  }
}
