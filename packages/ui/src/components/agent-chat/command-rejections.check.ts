/**
 * Guard: no agent-chat callback fires a command with a bare `void`.
 *
 * Every `AgentChatActions` command **rejects** on failure — the store sets
 * `slice.errorBanner` and then rethrows (`lib/agent-chat/store.ts`), so the
 * user-visible half is already handled and the throw is only a signal. `void p`
 * does not consume that rejection: it becomes an `unhandledrejection`, which is
 * console noise in development and a **hard failure of the deploy smoke test**
 * (`scripts/smoke-web.mjs` fails the deploy on any uncaught page error).
 *
 * The rule is therefore: attach a `.catch(...)` — `run(...)` in `AgentChatView`,
 * or an explicit handler where the caller wants to report more than the banner
 * does. This is a source check rather than a behavioural test because the
 * failure mode is a global event in a real browser, and because what has to be
 * prevented is the *pattern* coming back in the next callback somebody adds.
 *
 * *R8 m7.*
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|check)\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * `void actions.foo(…)` / `void api.agentChat.bar(…)`. Deliberately narrow on
 * the receiver: `void exhaustive` (the `satisfies never` idiom) and `void
 * props` are fine and common.
 *
 * A handler may be attached on the same line or on one of the next two — a
 * formatted `.catch((error: unknown) => {` often wraps — so the guard reads a
 * small window rather than a single line. Brace-matching a call expression
 * with a regex is not worth it: a caught rejection that this misses still gets
 * caught by the reader, while the pattern it exists to stop is one line long.
 */
const VOIDED_COMMAND = /\bvoid\s+(actions|api|transport)\.[A-Za-z0-9_.]*\(/;
const HANDLED = /\.catch\s*\(/;
const WINDOW = 3;

const offenders: string[] = [];
for (const file of sourceFiles(here)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!VOIDED_COMMAND.test(line)) return;
    const window = lines.slice(index, index + WINDOW).join("\n");
    if (HANDLED.test(window)) return;
    offenders.push(`${file.slice(here.length + 1)}:${index + 1}: ${line.trim()}`);
  });
}

assert.deepEqual(
  offenders,
  [],
  `a rejected agent-chat command must be caught, not voided:\n${offenders.join("\n")}`
);

console.log("agent-chat command-rejection guard passed");
