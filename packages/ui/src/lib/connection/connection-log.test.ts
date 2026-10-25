import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  CONNECTION_LOG_LIMIT,
  getConnectionLog,
  noteConnected,
  noteServerHealth,
  noteServerInfo,
  noteWsClosed,
  noteWsOpened,
  recordConnectionFailure,
  resetConnectionLog,
  subscribeConnectionLog
} from "./connection-log.ts";

beforeEach(() => resetConnectionLog());

const WS = "ws://daemon.test/ws";

describe("connection log", () => {
  it("keeps the last failure and a capped, deduplicated history", () => {
    recordConnectionFailure({ kind: "refused", detail: "x", at: 1 });
    recordConnectionFailure({ kind: "refused", detail: "x", at: 2 });
    recordConnectionFailure({ kind: "timeout", detail: "y", at: 3 });
    const log = getConnectionLog();
    assert.deepEqual(log.lastFailure, { kind: "timeout", detail: "y", at: 3 });
    assert.deepEqual(
      log.recent.map((entry) => [entry.kind, entry.count, entry.at]),
      [
        ["refused", 2, 2],
        ["timeout", 1, 3]
      ]
    );
    for (let i = 0; i < CONNECTION_LOG_LIMIT + 5; i += 1) {
      recordConnectionFailure({ kind: "unknown", detail: `e${i}`, at: 10 + i });
    }
    assert.equal(getConnectionLog().recent.length, CONNECTION_LOG_LIMIT);
    assert.equal(getConnectionLog().recent.at(-1)?.detail, `e${CONNECTION_LOG_LIMIT + 4}`);
  });

  it("a connect clears the explanation, keeps the history, and restarts the WebSocket count", () => {
    recordConnectionFailure({ kind: "refused", detail: "x", at: 1 });
    noteWsClosed(WS, 1006, 2);
    noteWsClosed(WS, 1006, 3);
    assert.equal(getConnectionLog().ws[WS]?.failures, 2);
    noteConnected(4);
    const log = getConnectionLog();
    assert.equal(log.lastFailure, null);
    assert.equal(log.recent.length, 1);
    assert.equal(log.connectedAt, 4);
    assert.equal(log.ws[WS]?.failures, 0);
    assert.equal(log.ws[WS]?.lastCloseCode, 1006);
    noteWsClosed(WS, 1006, 5);
    noteWsOpened(WS, 6);
    assert.equal(getConnectionLog().ws[WS]?.failures, 0);
    assert.equal(getConnectionLog().ws[WS]?.lastOpenAt, 6);
  });

  it("records what the daemon says about itself", () => {
    noteServerHealth({ protocol: 2 });
    assert.equal(getConnectionLog().serverProtocol, 2);
    noteServerInfo({ protocol: 1, build: "abc1234" });
    assert.equal(getConnectionLog().serverProtocol, 1);
    assert.equal(getConnectionLog().serverBuild, "abc1234");
    noteServerInfo({});
    assert.equal(getConnectionLog().serverProtocol, 1, "an older daemon's info keeps what /health said");
    assert.equal(getConnectionLog().serverBuild, null);
  });

  it("notifies subscribers with a new snapshot", () => {
    let calls = 0;
    const unsubscribe = subscribeConnectionLog(() => (calls += 1));
    const before = getConnectionLog();
    recordConnectionFailure({ kind: "dns", detail: "x", at: 1 });
    unsubscribe();
    recordConnectionFailure({ kind: "dns", detail: "y", at: 2 });
    assert.equal(calls, 1);
    assert.notEqual(getConnectionLog(), before);
  });
});
