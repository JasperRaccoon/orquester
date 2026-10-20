// Runs the Go toolchain for orq-agent: `$GO` if set, else `go` on PATH.
// Fails with a clear message when Go is not installed (orq-agent is written in
// Go so it cross-compiles with PTY/ConPTY support to every box platform).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const go = process.env.GO || "go";
const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(go, process.argv.slice(2), { cwd, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" } });
if (result.error) {
  console.error(`orq-agent: cannot run the Go toolchain (${go}): ${result.error.message}. Install Go ≥ 1.24 or set GO=/path/to/go.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
