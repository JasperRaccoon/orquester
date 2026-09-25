// Preloaded by every package's test script — `node --import tsx --import ../../scripts/test/assert-ok.mjs
// --test …`, the UI's `.check.ts` loop too; `node --test` hands `--import` on to the child process
// each test file runs in.
//
// Why. A failing `assert.ok(value)` or `assert(value)` with NO message makes Node write the message
// itself, and on Node 20 that can hang the test file. Its getErrMessage (lib/internal/assert/utils.js)
// takes the caller's raw V8 position — a position in the code V8 ran, tsx's esbuild output with
// `minifyWhitespace`, where a whole ESM module is one line — and applies it to the `.ts` file on disk:
// line 1, column = the offset in that one line, which lands on unrelated code. From every token up to
// that column it tries an acorn parse, over TypeScript acorn cannot parse (≈0.3 s at column 14 000);
// when no call parses there and the file runs on past column + 2500, findColumn asks readSync for 0
// bytes, takes the 0 for "not at EOF" and recurses on the same input — a full re-parse per level
// until the stack overflows. Measured on Node 20.20.2: a failing message-less assert in a 20 KB test
// file took 21 minutes to fail, and then said only `false == true`; where it does not hang, the
// message quotes some other line's code.
//
// What. `assert.ok` — and, through ./assert-ok-hooks.mjs, the callable default export and `strict` of
// node:assert and node:assert/strict — run Node 20's own innerOk below, unchanged but for that one
// generated message: the caller's position goes through the module's source map (tsx enables them)
// back to the `.ts` source, and the TypeScript parser picks out the call there. A message the test
// passes is used as is, an Error is thrown as is, and a call this cannot find leaves the message to
// AssertionError, which says `false == true` as Node does then. Node's getErrMessage is never reached.

import assert from "node:assert";
import fs from "node:fs";
import { createRequire, findSourceMap, register } from "node:module";
import { fileURLToPath } from "node:url";
import { isNativeError } from "node:util/types";

const { AssertionError } = assert;
// Taken now: a test that mocks `fs.readFileSync` must not change what a failure says.
const { readFileSync } = fs;
const require = createRequire(import.meta.url);

/** Node 20's innerOk (lib/internal/assert/utils.js), with `falsyMessage` for its getErrMessage. */
function innerOk(stackStartFn, argLen, value, message) {
  if (value) return;
  let generatedMessage = false;
  if (argLen === 0) {
    generatedMessage = true;
    message = "No value argument passed to `assert.ok()`";
  } else if (message == null) {
    generatedMessage = true;
    message = falsyMessage(stackStartFn);
  } else if (isNativeError(message) || message instanceof Error) {
    throw message;
  }
  const err = new AssertionError({ actual: value, expected: true, message, operator: "==", stackStartFn });
  err.generatedMessage = generatedMessage;
  throw err;
}

function ok(...args) {
  innerOk(ok, args.length, ...args);
}

// node:assert/strict exports `assert.strict`, which shares `ok` with `assert`.
assert.ok = ok;
assert.strict.ok = ok;

const callables = new WeakMap();

/** `target` — a builtin assert function — for every property, but a call runs `innerOk` above. */
export function callable(target) {
  let proxy = callables.get(target);
  if (proxy === undefined) {
    proxy = new Proxy(target, {
      apply: function apply(_target, _thisArg, args) {
        innerOk(apply, args.length, ...args);
      },
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return key === "strict" && typeof value === "function" ? callable(value) : value;
      }
    });
    callables.set(target, proxy);
  }
  return proxy;
}

register("./assert-ok-hooks.mjs", import.meta.url);

// ---------------------------------------------------------------------------------------------
// The message, worded as Node words it: "The expression evaluated to a falsy value:\n\n  <call>\n".

const messages = new Map();
const sourceFiles = new Map();

function falsyMessage(stackStartFn) {
  try {
    const site = callerSite(stackStartFn);
    if (site === undefined) return undefined;
    const key = `${site.getFileName()}:${site.getLineNumber()}:${site.getColumnNumber()}`;
    if (!messages.has(key)) {
      const position = sourcePosition(site);
      const code = position === undefined ? undefined : callAt(position);
      messages.set(key, code === undefined ? undefined : `The expression evaluated to a falsy value:\n\n  ${code}\n`);
    }
    return messages.get(key);
  } catch {
    return undefined;
  }
}

/** The raw V8 call site of whoever called `fn`. */
function callerSite(fn) {
  const { prepareStackTrace, stackTraceLimit } = Error;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, sites) => sites;
    const holder = {};
    Error.captureStackTrace(holder, fn);
    return holder.stack[0];
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = stackTraceLimit;
  }
}

/** Where the call is in the file as written, 0-based: through the source map when there is one. */
function sourcePosition(site) {
  const file = site.getFileName();
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  if (!file || file.startsWith("node:") || line == null || column == null) return undefined;
  const map = findSourceMap(file);
  // No map: the module ran as written, so V8's position is the file's own.
  if (map === undefined) return { path: toPath(file), line: line - 1, column: column - 1 };
  const entry = map.findEntry(line - 1, column - 1);
  if (entry?.originalSource === undefined) return undefined;
  return { path: toPath(entry.originalSource), line: entry.originalLine, column: entry.originalColumn };
}

function toPath(file) {
  return file.startsWith("file:") ? fileURLToPath(file) : file;
}

/** The innermost call whose callee holds the position — `assert.ok(…)`, `assert(…)` — as Node quotes it. */
function callAt({ path, line, column }) {
  const ts = require("typescript");
  let sourceFile = sourceFiles.get(path);
  if (sourceFile === undefined) {
    const kind = /\.[cm]?[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, kind);
    sourceFiles.set(path, sourceFile);
  }
  const lineStart = sourceFile.getLineStarts()[line];
  if (lineStart === undefined) return undefined;
  const offset = lineStart + column;
  let call;
  const visit = (node) => {
    if (offset < node.getStart(sourceFile) || offset >= node.getEnd()) return;
    const callee = ts.isCallExpression(node) ? node.expression : undefined;
    if (callee !== undefined && offset >= callee.getStart(sourceFile) && offset < callee.getEnd()) call = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (call === undefined) return undefined;
  const start = call.getStart(sourceFile);
  const { character } = sourceFile.getLineAndCharacterOfPosition(start);
  // Node's own normalisation: a continuation line loses up to the call's column of indentation.
  const [first, ...rest] = sourceFile.text.slice(start, call.getEnd()).split(/\r?\n/);
  return [first, ...rest.map((text) => text.slice(Math.min(character, text.search(/[^ \t]|$/))))].join("\n  ");
}
