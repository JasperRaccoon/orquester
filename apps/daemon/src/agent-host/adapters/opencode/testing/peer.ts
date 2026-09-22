/**
 * The scripted OpenCode mock peer (spec §9), shared by the server-pool tests
 * and the snapshot-budget tests.
 *
 * A tiny Node script written into a temp dir and launched through the *same*
 * `spawnProviderChild` path the real `opencode serve` uses, behind a shell shim
 * named `opencode`. It prints the real readiness line, serves `/global/health`
 * and the catalogue routes, and can be told to misbehave — so the spawn, the
 * stdout scrape, the handshake deadline, the auth header, the version gate and
 * the refcounted lifecycle are exercised without an account, a network call or
 * the real CLI.
 *
 * **Not covered**, said out loud rather than implied: the peer spawns no
 * grandchild, so nothing asserts `process.kill(-pid)` reaches a whole process
 * group (the reason `detached: true` is set), and `OPENCODE_CONFIG_CONTENT`
 * precedence is unverified.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MINIMUM_OPENCODE_VERSION } from "../semver.ts";

/**
 * `MOCK_MODE` selects the behaviour:
 *   `ok`          — ready line, then a healthy server on the requested port
 *   `old`         — healthy, but a version below the §4.1 minimum
 *   `unhealthy`   — `{healthy:false}`
 *   `silent`      — binds nothing and prints nothing (handshake deadline)
 *   `die`         — exits 3 before printing anything
 *   `noisy`       — prints the `OPENCODE_SERVER_PASSWORD` warning FIRST
 *   `slow`        — like `ok`, but the readiness line is delayed by
 *                   `MOCK_READY_DELAY_MS` (a cold `opencode serve` start)
 *
 * `MOCK_PROVIDER_STATUS` makes `GET /provider` answer that status instead of a
 * catalogue, which is how a catalogue failure is told apart from a start
 * failure. Every other catalogue route always answers.
 */
const PEER_SOURCE = `
import { createServer } from "node:http";

const mode = process.env.MOCK_MODE ?? "ok";
const version = process.env.MOCK_VERSION ?? "${MINIMUM_OPENCODE_VERSION}";
const readyDelayMs = Number(process.env.MOCK_READY_DELAY_MS ?? "0");
const providerStatus = Number(process.env.MOCK_PROVIDER_STATUS ?? "200");
const password = process.env.OPENCODE_SERVER_PASSWORD;
const portArg = process.argv.find((a) => a.startsWith("--port="));
const hostArg = process.argv.find((a) => a.startsWith("--hostname="));
const port = Number(portArg?.slice("--port=".length) ?? "0");
const host = hostArg?.slice("--hostname=".length) ?? "127.0.0.1";

const CATALOGUE = {
  "/provider": {
    all: [{ id: "openrouter", name: "OpenRouter", models: { "google/gemini-3.1-flash-lite": { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" } } }],
    connected: ["openrouter"],
    default: { openrouter: "google/gemini-3.1-flash-lite" }
  },
  "/agent": [{ name: "build", description: "Build agent", mode: "primary" }],
  "/command": [{ name: "init", description: "Initialise AGENTS.md" }],
  "/skill": [{ name: "review", description: "Review a diff", location: "/skills/review/SKILL.md" }]
};

if (mode === "die") {
  process.stderr.write("mock peer: fatal error\\n");
  process.exit(3);
}
if (mode === "silent") {
  setInterval(() => {}, 1000);
} else {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (password !== undefined && auth !== "Basic " + Buffer.from("opencode:" + password).toString("base64")) {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith("/global/health")) {
      const body = mode === "unhealthy"
        ? { healthy: false }
        : { healthy: true, version: mode === "old" ? "1.10.0" : version };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    const route = (req.url ?? "").split("?")[0];
    if (route === "/provider" && providerStatus !== 200) {
      res.writeHead(providerStatus, { "content-type": "application/json" }).end('{"error":"provider catalogue unavailable"}');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(CATALOGUE, route)) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(CATALOGUE[route]));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  server.listen(port, host, () => {
    const announce = () => {
      if (mode === "noisy") {
        process.stdout.write("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\\n");
      }
      process.stdout.write("opencode server listening on http://" + host + ":" + server.address().port + "\\n");
    };
    // A cold start: the port is bound but the CLI has not said so yet, which
    // is exactly the window the host used to spend its whole budget in.
    if (mode === "slow" && readyDelayMs > 0) {
      setTimeout(announce, readyDelayMs);
    } else {
      announce();
    }
  });
}
`;

/**
 * Verbatim-shaped output for the three CLI catalogue reads, short enough to
 * embed: `models --verbose` prints a slug line then its JSON body, `agent list`
 * prints slug + JSON, `debug skill` prints JSON objects.
 */
const CLI_MODELS_OUTPUT = `openrouter/google/gemini-3.1-flash-lite
{
  "id": "google/gemini-3.1-flash-lite",
  "providerID": "openrouter",
  "name": "Gemini 3.1 Flash Lite"
}`;

const CLI_AGENTS_OUTPUT = `build
{
  "name": "build",
  "description": "Build agent",
  "mode": "primary"
}`;

const CLI_SKILLS_OUTPUT = `[
  {
    "name": "review",
    "description": "Review a diff",
    "location": "/skills/review/SKILL.md"
  }
]`;

export interface Peer {
  dir: string;
  /** A shell shim named `opencode`, exactly as §9 describes the mock peer. */
  bin: string;
  cleanup: () => void;
}

export function makePeer(): Peer {
  const dir = mkdtempSync(join(tmpdir(), "orq-opencode-peer-"));
  const script = join(dir, "peer.mjs");
  writeFileSync(script, PEER_SOURCE, "utf8");
  // The shim swallows the `serve` subcommand and forwards the flags, so the
  // pool's real argv (`serve --hostname=… --port=…`) reaches the peer
  // unchanged. `--version` is answered by the shim itself: the real binary
  // prints and exits, and the adapter's version probe waits for that exit.
  const bin = join(dir, "opencode");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  echo "\${MOCK_VERSION:-${MINIMUM_OPENCODE_VERSION}}"`,
      "  exit 0",
      "fi",
      // The catalogue fallbacks (§4.5): the cwd-less snapshot reads these three
      // subcommands instead of starting a server, so the peer answers them in
      // the real shapes the parsers were written against.
      'if [ "$1" = "models" ]; then',
      `  cat <<'MODELS'`,
      CLI_MODELS_OUTPUT,
      "MODELS",
      "  exit 0",
      "fi",
      'if [ "$1" = "agent" ]; then',
      `  cat <<'AGENTS'`,
      CLI_AGENTS_OUTPUT,
      "AGENTS",
      "  exit 0",
      "fi",
      'if [ "$1" = "debug" ]; then',
      `  cat <<'SKILLS'`,
      CLI_SKILLS_OUTPUT,
      "SKILLS",
      "  exit 0",
      "fi",
      "shift",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`,
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  return { dir, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
