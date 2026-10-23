import assert from "node:assert/strict";
import test from "node:test";

import { mockProc } from "./leftover-processes.testing.ts";
import { ProviderLeftovers } from "./provider-leftovers.ts";

const LAUNCH = "launch-a";
const MARKED = `PATH=/bin\0ORQUESTER_AGENT_LAUNCH=${LAUNCH}\0`;
const OTHER = "PATH=/bin\0ORQUESTER_AGENT_LAUNCH=launch-b\0";
const BROWSER_DAEMON = `${MARKED}AGENT_BROWSER_DAEMON=1\0`;

function leftovers(env: Record<string, string> = { ORQUESTER_AGENT_LAUNCH: LAUNCH }) {
  const warnings: unknown[] = [];
  const sweep = new ProviderLeftovers({
    env,
    label: "test",
    logger: { debug: () => undefined, warn: (...args) => warnings.push(args) }
  });
  return { sweep, warnings };
}

test("a CLI that leads its group: its own exit stops the marked members, never a shared daemon nor another launch", async (t) => {
  const proc = mockProc(t, {
    // `codex app-server`, spawned detached: it leads its group.
    900: { environ: MARKED, starttime: 90, sid: 900, pgid: 900, ppid: process.pid },
    901: { environ: MARKED, starttime: 91, sid: 900, pgid: 900, ppid: 900, diesOn: "SIGTERM" },
    902: { environ: BROWSER_DAEMON, starttime: 92, sid: 900, pgid: 900, ppid: 900, comm: "agent-browser-l" },
    903: { environ: OTHER, starttime: 93, sid: 900, pgid: 900 },
    904: { environ: MARKED, starttime: 94, sid: 904, pgid: 904, ppid: 1 }
  });
  const { sweep, warnings } = leftovers();
  await sweep.watchGroup(900);
  proc.table.delete(900); // the CLI crashed: no stop signalled its group
  await sweep.sweep();
  assert.deepEqual(proc.signals, [[901, "SIGTERM"]]);
  assert.equal(proc.table.has(902), true, "the shared agent-browser daemon survives");
  assert.deepEqual(warnings, []);
});

test("a CLI in the host's group: only its helpers, recorded at its first init, are stopped — never the user's later work", async (t) => {
  const host = process.pid;
  const proc = mockProc(t, {
    // The Claude CLI, spawned by the SDK into the host's session and group.
    920: { environ: MARKED, starttime: 20, sid: 1, pgid: 1, ppid: host },
    // Its MCP server, and the server that server's wrapper started.
    921: { environ: MARKED, starttime: 21, sid: 1, pgid: 1, ppid: 920, diesOn: "SIGTERM" },
    922: { environ: MARKED, starttime: 22, sid: 1, pgid: 1, ppid: 921, diesOn: "SIGTERM" },
    // Another chat's CLI, in the same host group.
    930: { environ: OTHER, starttime: 30, sid: 1, pgid: 1, ppid: host },
    931: { environ: OTHER, starttime: 31, sid: 1, pgid: 1, ppid: 930 }
  });
  proc.table.set(host, { environ: "PATH=/bin\0", starttime: 1, sid: 1, pgid: 1 });
  const { sweep } = leftovers();
  await sweep.watchGroup(920);
  await sweep.recordHelpers(); // the first `system/init`

  // The turn runs a background shell (a new child of the CLI) and a dev server under it.
  proc.table.set(923, { environ: MARKED, starttime: 23, sid: 1, pgid: 1, ppid: 920 });
  proc.table.set(924, { environ: MARKED, starttime: 24, sid: 1, pgid: 1, ppid: 923 });
  await sweep.recordHelpers(); // the turn's `result`

  proc.table.delete(920); // the CLI exits
  await sweep.sweep();
  assert.deepEqual(proc.signals, [[921, "SIGTERM"], [922, "SIGTERM"]]);
  for (const pid of [host, 923, 924, 930, 931]) assert.equal(proc.table.has(pid), true, `pid ${pid} untouched`);
});

test("the wrapper's server is caught by a refresh while the wrapper lives, and stopped after the wrapper is gone", async (t) => {
  const host = process.pid;
  const proc = mockProc(t, {
    940: { environ: MARKED, starttime: 40, sid: 1, pgid: 1, ppid: host },
    941: { environ: MARKED, starttime: 41, sid: 1, pgid: 1, ppid: 940 }
  });
  proc.table.set(host, { environ: "PATH=/bin\0", starttime: 1, sid: 1, pgid: 1 });
  const { sweep } = leftovers();
  await sweep.recordHelpers();
  proc.table.set(942, { environ: MARKED, starttime: 42, sid: 1, pgid: 1, ppid: 941, diesOn: "SIGTERM" });
  await sweep.recordHelpers();
  proc.table.delete(941); // `bun run start` exits; `bun server.ts` is orphaned
  proc.table.set(942, { environ: MARKED, starttime: 42, sid: 1, pgid: 1, ppid: 1, diesOn: "SIGTERM" });
  proc.table.delete(940);
  await sweep.sweep();
  assert.deepEqual(proc.signals, [[942, "SIGTERM"]]);
});

test("a launch without a marker reads and signals nothing", async (t) => {
  const proc = mockProc(t, { 950: { environ: "PATH=/bin\0", starttime: 50, sid: 950, pgid: 950, ppid: process.pid } });
  const { sweep } = leftovers({});
  await sweep.watchGroup(950);
  await sweep.recordHelpers();
  await sweep.sweep();
  assert.deepEqual(proc.signals, []);
  assert.equal(proc.reads.some((path) => path.endsWith("/environ")), false);
});

test("a CLI that never recorded anything sweeps nothing", async (t) => {
  const proc = mockProc(t, { 960: { environ: MARKED, starttime: 60, sid: 1, pgid: 1 } });
  const { sweep } = leftovers();
  await sweep.sweep();
  assert.deepEqual(proc.signals, []);
});
