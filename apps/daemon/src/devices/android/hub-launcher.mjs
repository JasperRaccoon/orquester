// Runs expo-device-hub's CLI (argv[2]) with the remaining arguments, its console output redacted:
// with --require-token the hub prints its session token in the startup link, and that output goes
// to a log file. The local Android host (hub.ts) starts the hub through this file; the token itself
// is read from the hub's 0600 state file (EXPO_DEVICE_HUB_STATE_DIR/server-<port>.json).
import { pathToFileURL } from "node:url";

const [cli, ...args] = process.argv.slice(2);
if (!cli) {
  console.error("usage: hub-launcher.mjs <expo-device-hub cli.mjs> [args…]");
  process.exit(2);
}
const redact = (value) => (typeof value === "string" ? value.replace(/([?&]token=)[A-Za-z0-9._~-]+/g, "$1<redacted>") : value);
for (const method of ["log", "info", "warn", "error"]) {
  const original = console[method].bind(console);
  console[method] = (...values) => original(...values.map(redact));
}
process.argv = [process.argv[0], cli, ...args];
await import(pathToFileURL(cli).href);
