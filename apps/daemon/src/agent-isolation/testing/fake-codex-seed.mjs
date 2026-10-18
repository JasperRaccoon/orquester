// A fake `codex app-server` for the state-DB seeding tests: NDJSON framing
// without a `jsonrpc` field, `initialize` answered with `codexHome`, and the
// state DB file created in $CODEX_HOME before the reply — as codex-cli 0.159.0
// does on a temp home (observed 2026-10-18: `state_5.sqlite` present at the
// reply, exit 0 on stdin EOF).
//
// Env: CODEX_HOME (set by the seeder);
//   FAKE_SEED_LOG — append one JSON line per event (start, initialize with the
//     kind of `$CODEX_HOME/sessions` and whether `auth.json` exists at that
//     moment, exit);
//   FAKE_SEED_DB — the file name to create (default state_5.sqlite; "" = none);
//   FAKE_SEED_HANG=1 — never answer `initialize`;
//   FAKE_SEED_IGNORE_EOF=1 — keep running after stdin closes (until killed).
//
// Run as `node fake-codex-seed.mjs app-server`.

import { appendFileSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.CODEX_HOME;
const DB = process.env.FAKE_SEED_DB ?? "state_5.sqlite";

function log(event) {
  if (process.env.FAKE_SEED_LOG) {
    appendFileSync(process.env.FAKE_SEED_LOG, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
  }
}

function sessionsKind() {
  const path = join(HOME, "sessions");
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "link";
    if (st.isDirectory()) return readdirSync(path).length === 0 ? "empty-dir" : "dir";
    return "other";
  } catch {
    return "missing";
  }
}

function authPresent() {
  try {
    lstatSync(join(HOME, "auth.json"));
    return true;
  } catch {
    return false;
  }
}

log({ event: "start" });
process.on("exit", () => log({ event: "exit" }));
process.on("SIGTERM", () => process.exit(143));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    const frame = JSON.parse(line);
    if (frame.id === undefined) {
      log({ event: "notification", method: frame.method });
      continue;
    }
    if (frame.method !== "initialize") {
      process.stdout.write(`${JSON.stringify({ id: frame.id, error: { code: -32600, message: "unexpected" } })}\n`);
      continue;
    }
    log({ event: "initialize", sessions: sessionsKind(), auth: authPresent() });
    if (process.env.FAKE_SEED_HANG === "1") continue;
    if (DB !== "") writeFileSync(join(HOME, DB), "");
    process.stdout.write(
      `${JSON.stringify({ id: frame.id, result: { userAgent: "fake/0.159.0", codexHome: HOME, platformFamily: "unix", platformOs: "linux" } })}\n`
    );
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_SEED_IGNORE_EOF === "1") {
    setInterval(() => undefined, 1 << 30);
    return;
  }
  process.exit(0);
});
