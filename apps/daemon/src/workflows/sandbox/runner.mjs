// Automated workflows — the sandbox SUPERVISOR (spec §5.6). Plain ESM JavaScript, run by `node`
// directly (never tsx): `node runner.mjs <attemptDir>`.
//
// The daemon spawns this detached (`setsid`: a session and process group of its own) with its stdio
// on /dev/null, so it survives a daemon restart and nothing it does depends on the daemon being up.
// It supervises ONE attempt:
//
//   1. reads `<attemptDir>/spec.json` (written by the daemon's `spawn()`);
//   2. starts the work as its child — `bash -c <script>` / `sh -c <script>` for a shell block, or
//      `node --max-old-space-size=<memoryMb> code-host.mjs <attemptDir>` for a code block — leading
//      a process group of its OWN (so the runner can SIGKILL the work's whole group, grandchildren
//      included, without killing itself before it records the exit);
//   3. copies the child's stdout/stderr pipes into `stdout.log` / `stderr.log`, each capped at
//      `maxLogBytes` (past the cap: one notice line, then everything is dropped);
//   4. enforces the wall-clock deadline ITSELF (so a timeout holds while the daemon is down): SIGTERM
//      the work's group, SIGKILL after `killGraceMs`. A SIGTERM to the runner (the daemon's cancel)
//      does the same;
//   5. writes `exit.json` = {code, signal, timedOut, cancelled, endedAt, stdoutBytes, stderrBytes, …}
//      atomically (tmp + rename), then exits.
//
// A work process left in the work's group after the child exits (a `cmd &` the script never waited
// for) is ended too: an attempt never outlives its record. Something that daemonized into a session
// of its own escapes the group; it still carries the launch marker (ORQUESTER_AGENT_LAUNCH), so
// Settings → System lists it and can kill it.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const attemptDir = process.argv[2];
if (!attemptDir) {
  process.exit(2);
}

// Signal handlers FIRST: until they are installed a SIGTERM (a cancel right after the spawn) would
// kill the runner outright and no exit would ever be recorded. Handlers run from the event loop, so
// they only act once the synchronous setup below has started the work. `runner.json` then tells
// the daemon's kill() that a SIGTERM will be caught.
process.on("SIGTERM", () => terminate("cancel"));
process.on("SIGINT", () => terminate("cancel"));
process.on("SIGHUP", () => {
  // A daemon restart must never end the attempt.
});
try {
  writeFileSync(join(attemptDir, "runner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
} catch {
  // the daemon's kill() falls back to its own bound
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_HOST = join(HERE, "code-host.mjs");

/** Appends one runner diagnostic line to stderr.log (never throws). */
function note(line) {
  try {
    const fd = openSync(join(attemptDir, "stderr.log"), "a", 0o600);
    try {
      writeSync(fd, `[orquester] ${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // nothing else to tell
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Linux: field 22 of /proc/<pid>/stat; 0 where there is no /proc. */
function starttimeOf(pid) {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = content.slice(content.lastIndexOf(")") + 2).split(" ");
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

let spec;
try {
  spec = JSON.parse(readFileSync(join(attemptDir, "spec.json"), "utf8"));
} catch (error) {
  note(`could not read spec.json: ${error instanceof Error ? error.message : String(error)}`);
  writeJsonAtomic(join(attemptDir, "exit.json"), {
    code: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    endedAt: new Date().toISOString(),
    stdoutBytes: 0,
    stderrBytes: 0,
    error: "spec.json unreadable"
  });
  process.exit(1);
}

const maxLogBytes = Number(spec.maxLogBytes) > 0 ? Number(spec.maxLogBytes) : 50 * 1024 * 1024;
const killGraceMs = Number(spec.killGraceMs) >= 0 ? Number(spec.killGraceMs) : 5000;
const deadlineAt = Number(spec.deadlineAt);

/** A capped log sink over a synchronously written file. */
function createSink(name, label) {
  const fd = openSync(join(attemptDir, name), "a", 0o600);
  const sink = { fd, written: 0, produced: 0, capped: false, closed: false };
  sink.write = (chunk) => {
    sink.produced += chunk.length;
    if (sink.capped || sink.closed) {
      return;
    }
    const room = maxLogBytes - sink.written;
    if (chunk.length <= room) {
      writeSync(fd, chunk);
      sink.written += chunk.length;
      return;
    }
    // Cut at a UTF-8 boundary: back off continuation bytes (10xxxxxx) so the notice never lands
    // inside a character.
    let cut = Math.max(0, room);
    while (cut > 0 && (chunk[cut] & 0xc0) === 0x80) {
      cut -= 1;
    }
    if (cut > 0) {
      writeSync(fd, chunk.subarray(0, cut));
      sink.written += cut;
    }
    const notice = Buffer.from(
      `\n[orquester] ${label} passed ${maxLogBytes} bytes; the rest of it was dropped.\n`,
      "utf8"
    );
    writeSync(fd, notice);
    sink.written += notice.length;
    sink.capped = true;
  };
  sink.close = () => {
    if (!sink.closed) {
      sink.closed = true;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  };
  return sink;
}

const out = createSink("stdout.log", "stdout");
const err = createSink("stderr.log", "stderr");

let command;
let args;
if (spec.kind === "code") {
  command = process.execPath;
  args = [];
  if (Number(spec.memoryMb) > 0) {
    args.push(`--max-old-space-size=${Math.floor(Number(spec.memoryMb))}`);
  }
  args.push(CODE_HOST, attemptDir);
} else {
  command = spec.shell === "sh" ? "sh" : "bash";
  let script = "";
  try {
    script = readFileSync(join(attemptDir, "script.sh"), "utf8");
  } catch (error) {
    note(`could not read script.sh: ${error instanceof Error ? error.message : String(error)}`);
  }
  args = ["-c", script];
}

let child;
try {
  child = spawn(command, args, {
    cwd: spec.cwd || attemptDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // A group of its own: the runner kills the work's group without killing itself.
    detached: true
  });
} catch (error) {
  child = null;
  note(`could not start ${command}: ${error instanceof Error ? error.message : String(error)}`);
}

let timedOut = false;
let cancelled = false;
let terminating = false;
let killTimer = null;
let childExit = null;
let spawnError = null;

function signalGroup(signal) {
  if (!child || !child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function terminate(reason) {
  if (reason === "timeout") {
    timedOut = true;
  } else {
    cancelled = true;
  }
  if (terminating) {
    return;
  }
  terminating = true;
  signalGroup("SIGTERM");
  killTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
}

let finishing = false;
process.on("uncaughtException", (error) => {
  note(`runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (finishing) {
    process.exit(1);
  }
  signalGroup("SIGKILL");
  finish();
});

if (child) {
  if (child.pid) {
    try {
      writeJsonAtomic(join(attemptDir, "child.json"), { pid: child.pid, starttime: starttimeOf(child.pid) });
    } catch {
      // informational only
    }
  }
  child.stdout?.on("data", (chunk) => out.write(chunk));
  child.stderr?.on("data", (chunk) => err.write(chunk));
  child.on("error", (error) => {
    spawnError = error instanceof Error ? error.message : String(error);
  });
}

let deadlineTimer = null;
function armDeadline() {
  if (!Number.isFinite(deadlineAt)) {
    return;
  }
  const left = deadlineAt - Date.now();
  if (left <= 0) {
    terminate("timeout");
    return;
  }
  // setTimeout caps at ~24.8 days; re-arm in slices so a long deadline stays exact.
  deadlineTimer = setTimeout(armDeadline, Math.min(left, 2 ** 31 - 1));
}
armDeadline();

function finish() {
  if (finishing) {
    return;
  }
  finishing = true;
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (killTimer) clearTimeout(killTimer);
  out.close();
  if (spawnError) {
    note(`could not start ${command}: ${spawnError}`);
  }
  err.close();
  try {
    rmSync(join(attemptDir, "input.json"), { force: true });
  } catch {
    // best effort: the host deletes it right after reading
  }
  const exit = {
    code: childExit ? childExit.code : spawnError || !child ? 127 : null,
    signal: childExit ? childExit.signal : null,
    timedOut,
    cancelled,
    endedAt: new Date().toISOString(),
    stdoutBytes: out.written,
    stderrBytes: err.written,
    stdoutProduced: out.produced,
    stderrProduced: err.produced,
    stdoutCapped: out.capped,
    stderrCapped: err.capped
  };
  if (spawnError || !child) {
    exit.error = `could not start ${command}`;
  }
  try {
    writeJsonAtomic(join(attemptDir, "exit.json"), exit);
  } catch (error) {
    note(`could not write exit.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

if (!child || !child.pid) {
  // spawn() failed synchronously or asynchronously before a pid existed; the 'error' event (if
  // any) fires on the next tick.
  if (child) {
    child.on("error", () => setImmediate(finish));
    child.on("close", () => finish());
  } else {
    finish();
  }
} else {
  let streamsOpen = 2;
  let exited = false;
  let drainTimer = null;
  const maybeFinish = () => {
    if (exited && streamsOpen === 0) {
      if (drainTimer) clearTimeout(drainTimer);
      finish();
    }
  };
  const streamDone = () => {
    streamsOpen -= 1;
    maybeFinish();
  };
  if (child.stdout) child.stdout.once("close", streamDone);
  else streamsOpen -= 1;
  if (child.stderr) child.stderr.once("close", streamDone);
  else streamsOpen -= 1;
  child.once("exit", (code, signal) => {
    exited = true;
    childExit = { code, signal };
    // Whatever the child left in its group (a background `cmd &`) holds the pipes open and would
    // outlive the attempt: end it, SIGKILL after the grace.
    const survivors = signalGroup("SIGTERM");
    if (streamsOpen > 0) {
      drainTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        // The pipes close once the last holder is gone; give up on them shortly after.
        drainTimer = setTimeout(() => {
          streamsOpen = 0;
          maybeFinish();
        }, 1000);
      }, survivors ? killGraceMs : 0);
    }
    maybeFinish();
  });
}
