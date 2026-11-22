// The ProxyCommand of every Orquester `orq-<name>` ssh alias (spec 2026-11-22 §4.3; protocol in
// packages/api/src/agent-ssh.ts). Plain Node with no dependencies and no TypeScript, so ssh starts
// it fast: connect to the daemon's proxy socket, send one request line, read one answer line, then
// pipe stdin/stdout raw. On a refusal, print one line to stderr and exit 255 as ssh does.
//
// Usage: node ssh-proxy-helper.mjs <socket path> <alias> [<chat id>]

import { createConnection } from "node:net";

const MAX_ANSWER_BYTES = 8192;
const [socketPath, alias, threadId] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${alias ?? "orq"}: ${message}\n`);
  process.exit(255);
}

if (!socketPath || !alias) fail("usage: ssh-proxy-helper.mjs <socket> <alias> [<chat id>]");

const socket = createConnection(socketPath);
let answered = false;
let buffered = Buffer.alloc(0);

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ v: 1, alias, ...(threadId ? { threadId } : {}) })}\n`);
});

socket.on("error", (error) => {
  if (answered) process.exit(0);
  const code = error && error.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") fail("Orquester is not running on this machine, so its ssh aliases are unavailable until it starts again.");
  fail(`could not reach Orquester (${code ?? "error"}).`);
});

function onData(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  const newline = buffered.indexOf(0x0a);
  if (newline < 0) {
    if (buffered.length > MAX_ANSWER_BYTES) fail("Orquester sent an unreadable answer.");
    return;
  }
  socket.off("data", onData);
  answered = true;
  let response;
  try {
    response = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
  } catch {
    fail("Orquester sent an unreadable answer.");
  }
  if (!response || response.ok !== true) {
    const message = response && typeof response.message === "string" ? response.message : "Orquester refused the connection.";
    const fix = response && typeof response.fix === "string" ? ` ${response.fix}` : "";
    fail(`${message}${fix}`);
  }
  const rest = buffered.subarray(newline + 1);
  if (rest.length > 0) process.stdout.write(rest);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}

socket.on("data", onData);
socket.on("end", () => {
  if (!answered) fail("Orquester closed the connection before answering.");
});
socket.on("close", () => {
  if (!answered) fail("Orquester closed the connection before answering.");
  process.stdout.end(() => process.exit(0));
});
