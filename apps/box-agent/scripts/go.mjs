// Runs the Go toolchain for orq-agent: `$GO` if set, else `go` on PATH.
// Fails with a clear message when Go is not installed (orq-agent is written in
// Go so it cross-compiles with PTY/ConPTY support to every box platform).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const go = process.env.GO || "go";
const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
let args = process.argv.slice(2);
// Builds stay static (no cgo). The race detector needs cgo, so `-race` turns it
// on where Go's C compiler runs, and is dropped (with a warning) where it does not.
let cgo = "0";
if (args.includes("-race")) {
  const cc = spawnSync(go, ["env", "CC"], { cwd, encoding: "utf8" }).stdout?.trim().split(/\s+/)[0] || "cc";
  if (spawnSync(cc, ["--version"], { stdio: "ignore" }).status === 0) cgo = "1";
  else {
    console.warn(`orq-agent: the race detector needs a C compiler (${cc} did not run); testing without -race.`);
    args = args.filter((arg) => arg !== "-race");
  }
}
const result = spawnSync(go, args, { cwd, stdio: "inherit", env: { ...process.env, CGO_ENABLED: cgo } });
if (result.error) {
  console.error(`orq-agent: cannot run the Go toolchain (${go}): ${result.error.message}. Install Go ≥ 1.24 or set GO=/path/to/go.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
