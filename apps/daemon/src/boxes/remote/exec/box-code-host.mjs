// Ephemeral AI VMs — the CODE block host for a workflow run IN A BOX (spec §8.8). The box twin of
// workflows/sandbox/code-host.mjs, started by the daemon through orq-agent as
//
//   node [--max-old-space-size=<memoryMb>] --input-type=module -e <this file's source>
//
// Nothing of the attempt is written to disk in the box: the block's secrets must never be in a
// file there. Everything arrives on STDIN as one JSON document,
//
//   {nonce, source, context: {input, nodes, trigger, run, project, secrets}, projectPath,
//    maxOutputBytes, deadlineAt}
//
// the user's module is imported from a `data:` URL, and the outcome goes back on STDOUT as the
// last thing written, one line:
//
//   \x1eORQ-RESULT:<nonce>:<base64 of the result JSON>\n
//
// (the same {ok, value} | {ok: false, error} | {stop, reason} as code-host.mjs's result.json).
// The daemon strips that line from the log it keeps and writes result.json on the HOST. The
// nonce is per attempt and travels only on stdin, so the block's own output cannot forge it.
// `log(...)` writes to stdout, `require` is `createRequire(<projectPath>/package.json)`.

import { createRequire } from "node:module";
import { join } from "node:path";
import { format } from "node:util";

let settled = false;

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

let nonce = null;

/** `result` is the object to report, or its JSON already serialized. */
function settle(result, exitCode) {
  if (settled) {
    return;
  }
  settled = true;
  if (nonce === null) {
    process.stderr.write("[orquester] the code block's input could not be read.\n");
    process.exit(exitCode || 1);
  }
  const json = typeof result === "string" ? result : JSON.stringify(result);
  const line = `\x1eORQ-RESULT:${nonce}:${Buffer.from(json, "utf8").toString("base64")}\n`;
  // Exit only once the line is out: stdout is a pipe, asynchronous on some platforms.
  process.stdout.write(line, () => process.exit(exitCode));
}

process.on("unhandledRejection", (reason) => {
  settle({ ok: false, error: errorOf(reason) }, 1);
});
process.on("uncaughtException", (error) => {
  settle({ ok: false, error: errorOf(error) }, 1);
});

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  payload = null;
}
if (!payload || typeof payload.nonce !== "string" || typeof payload.source !== "string") {
  settle({ ok: false, error: { message: "Could not read the block's input." } }, 1);
} else {
  nonce = payload.nonce;
  const context = payload.context && typeof payload.context === "object" ? payload.context : {};
  const maxOutputBytes = Number(payload.maxOutputBytes) > 0 ? Number(payload.maxOutputBytes) : 16 * 1024 * 1024;
  const projectPath = typeof payload.projectPath === "string" && payload.projectPath ? payload.projectPath : process.cwd();
  const deadlineAt = Number(payload.deadlineAt);

  // While the daemon is away it cannot enforce the deadline: a block still waiting on something
  // past it (plus the kill grace) ends itself. A busy loop is ended by the daemon on its return.
  if (Number.isFinite(deadlineAt)) {
    const left = deadlineAt - Date.now() + 5_000;
    const timer = setTimeout(() => {
      process.stderr.write("[orquester] the code block ran past its deadline.\n");
      process.exit(124);
    }, Math.max(0, Math.min(left, 2 ** 31 - 1)));
    timer.unref();
  }

  const log = (...args) => {
    process.stdout.write(`${format(...args)}\n`);
  };

  const stop = (reason) => {
    const result = { stop: true };
    if (reason !== undefined && reason !== null) {
      result.reason = String(reason);
    }
    settle(result, 0);
  };

  await main();

  async function main() {
    let mod;
    try {
      mod = await import(`data:text/javascript;base64,${Buffer.from(payload.source, "utf8").toString("base64")}`);
    } catch (error) {
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
      settle({ ok: false, error: errorOf(error) }, 1);
      return;
    }
    let json;
    try {
      json = JSON.stringify(value === undefined ? null : value);
    } catch (error) {
      settle({ ok: false, error: { message: `The code block returned a value that is not JSON-serializable: ${errorOf(error).message}` } }, 1);
      return;
    }
    if (json === undefined) {
      settle({ ok: false, error: { message: `The code block returned a ${typeof value}, which is not JSON-serializable.` } }, 1);
      return;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > maxOutputBytes) {
      settle({ ok: false, error: { message: `The code block returned ${bytes} bytes of JSON; the limit is ${maxOutputBytes} bytes.` } }, 1);
      return;
    }
    settle(`{"ok":true,"value":${json}}`, 0);
  }
}
