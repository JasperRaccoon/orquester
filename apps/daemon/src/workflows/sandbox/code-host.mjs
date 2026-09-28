// Automated workflows — the CODE block host (spec §5.6). Plain ESM JavaScript, started by
// runner.mjs as `node --max-old-space-size=<memoryMb> code-host.mjs <attemptDir>`.
//
// It reads `<attemptDir>/input.json` ({input, nodes, trigger, run, project, secrets} — 0600) and
// deletes it at once, reads `<attemptDir>/spec.json` for the project path, imports the user's
// module `<attemptDir>/block.mjs` (top-level await works: it is a plain ES module) and calls its
// default export with
//
//   {input, nodes, trigger, run, project, secrets, log, stop, require}
//
// where `require` is `createRequire(<projectPath>/package.json)` (the project's npm packages),
// `log(...args)` writes one line to stdout, and `stop(reason?)` ends the run as stopped. `fetch` is
// Node's global. The outcome goes to `<attemptDir>/result.json`, atomically:
//
//   {ok: true, value}                      — the return value (JSON-serializable, ≤ maxOutputBytes)
//   {ok: false, error: {message, stack?}}  — a throw, a bad module, a value that cannot be kept
//   {stop: true, reason?}                  — stop() was called
//
// The host then exits on its own, so a module that leaves a timer or a socket open does not hold
// the attempt until its deadline.

import { createRequire } from "node:module";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

const attemptDir = process.argv[2];
if (!attemptDir) {
  process.exit(2);
}

const resultPath = join(attemptDir, "result.json");
let settled = false;

function writeResult(result) {
  const tmp = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(tmp, typeof result === "string" ? result : JSON.stringify(result), { mode: 0o600 });
  renameSync(tmp, resultPath);
}

function errorOf(error) {
  if (error instanceof Error) {
    return { message: error.message || String(error), ...(error.stack ? { stack: String(error.stack) } : {}) };
  }
  let message;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { message: `Thrown value: ${message}` };
}

/** `result` is the object to write, or its JSON already serialized. */
function settle(result, exitCode) {
  if (settled) {
    return;
  }
  settled = true;
  try {
    writeResult(result);
  } catch (error) {
    process.stderr.write(`[orquester] could not write result.json: ${errorOf(error).message}\n`);
    exitCode = 1;
  }
  // stdout/stderr are pipes: synchronous on Linux, so nothing logged before this is lost.
  process.exit(exitCode);
}

/** A sentinel that unwinds the user's stack when stop() is called from inside a promise chain. */
class StopSignal {
  constructor(reason) {
    this.reason = reason;
  }
}

let spec = {};
try {
  spec = JSON.parse(readFileSync(join(attemptDir, "spec.json"), "utf8"));
} catch {
  // the project path falls back to the cwd
}

let context = {};
const inputPath = join(attemptDir, "input.json");
try {
  context = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (error) {
  if (error && error.code !== "ENOENT") {
    settle({ ok: false, error: { message: `Could not read the block's input: ${errorOf(error).message}` } }, 1);
  }
} finally {
  rmSync(inputPath, { force: true });
}

const maxOutputBytes = Number(spec.maxOutputBytes) > 0 ? Number(spec.maxOutputBytes) : 16 * 1024 * 1024;
const projectPath = typeof spec.projectPath === "string" && spec.projectPath ? spec.projectPath : process.cwd();

const log = (...args) => {
  process.stdout.write(`${format(...args)}\n`);
};

const stop = (reason) => {
  const result = { stop: true };
  if (reason !== undefined && reason !== null) {
    result.reason = String(reason);
  }
  settle(result, 0);
  // Not reached (settle exits); keeps callers that `await stop()` from continuing if it ever were.
  throw new StopSignal(reason);
};

process.on("unhandledRejection", (reason) => {
  if (reason instanceof StopSignal) return;
  settle({ ok: false, error: errorOf(reason) }, 1);
});
process.on("uncaughtException", (error) => {
  if (error instanceof StopSignal) return;
  settle({ ok: false, error: errorOf(error) }, 1);
});

async function main() {
  let mod;
  try {
    mod = await import(pathToFileURL(join(attemptDir, "block.mjs")).href);
  } catch (error) {
    if (error instanceof StopSignal) return;
    settle({ ok: false, error: errorOf(error) }, 1);
    return;
  }
  const fn = mod.default;
  if (typeof fn !== "function") {
    settle(
      {
        ok: false,
        error: {
          message:
            fn === undefined
              ? "The code block has no default export. Write `export default async function ({ input }) { … }`."
              : `The code block's default export is a ${fn === null ? "null" : typeof fn}, not a function. Write \`export default async function ({ input }) { … }\`.`
        }
      },
      1
    );
    return;
  }
  let value;
  try {
    value = await fn({
      input: context.input,
      nodes: context.nodes ?? {},
      trigger: context.trigger,
      run: context.run,
      project: context.project,
      secrets: context.secrets ?? {},
      log,
      stop,
      require: createRequire(join(projectPath, "package.json"))
    });
  } catch (error) {
    if (error instanceof StopSignal) return;
    settle({ ok: false, error: errorOf(error) }, 1);
    return;
  }
  let json;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch (error) {
    settle(
      { ok: false, error: { message: `The code block returned a value that is not JSON-serializable: ${errorOf(error).message}` } },
      1
    );
    return;
  }
  if (json === undefined) {
    // A function or a symbol at the top level.
    settle({ ok: false, error: { message: `The code block returned a ${typeof value}, which is not JSON-serializable.` } }, 1);
    return;
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxOutputBytes) {
    settle(
      {
        ok: false,
        error: { message: `The code block returned ${bytes} bytes of JSON; the limit is ${maxOutputBytes} bytes.` }
      },
      1
    );
    return;
  }
  settle(`{"ok":true,"value":${json}}`, 0);
}

await main();
