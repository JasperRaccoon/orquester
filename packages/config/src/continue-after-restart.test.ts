import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentThreadHeadSchema, continueThreadsForProject, parseAppConfig } from "./index.ts";

describe("continuing chats after an agent host restart (spec 2026-11-01 R1, R2)", () => {
  it("is on by default; a stored false stays off; the project's own choice wins over either", () => {
    const fresh = parseAppConfig({}).agents;
    assert.equal(continueThreadsForProject(fresh, "/w/p"), true);
    const off = parseAppConfig({ agents: { continueThreadsAfterRestart: false } }).agents;
    assert.equal(continueThreadsForProject(off, "/w/p"), false);
    const pinned = parseAppConfig({
      agents: { continueThreadsAfterRestart: false, continueThreadsByProject: { "/w/p": true, "/w/q": false } }
    }).agents;
    assert.equal(continueThreadsForProject(pinned, "/w/p"), true);
    assert.equal(continueThreadsForProject({ ...pinned, continueThreadsAfterRestart: true }, "/w/q"), false);
  });

  const head = {
    id: "t",
    projectPath: "/p",
    cwd: "/p",
    title: "x",
    adapter: "claude",
    refId: "claude",
    accountId: "",
    home: "system",
    modelSelection: { model: "m" },
    runtimeMode: "auto",
    session: { status: "stopped" },
    createdAt: "t",
    updatedAt: "t"
  };

  it("reads an older host's marker, and a revival marker, keeping what it records", () => {
    assert.deepEqual(agentThreadHeadSchema.parse({ ...head, continueAfterRestart: { turnId: "turn-1", markedAt: "m" } }).continueAfterRestart, {
      turnId: "turn-1",
      markedAt: "m"
    });
    const revival = {
      turnId: "turn-1",
      markedAt: "m",
      revival: true,
      stoppedWork: [{ name: "Review", kind: "subagent" }],
      moreStoppedWork: 2,
      requestCancelled: true
    };
    assert.deepEqual(agentThreadHeadSchema.parse({ ...head, continueAfterRestart: revival }).continueAfterRestart, revival);
  });

  it("a malformed new field reads as none, never as a thread nothing can read", () => {
    const parsed = agentThreadHeadSchema.parse({
      ...head,
      continueAfterRestart: {
        turnId: "turn-1",
        revival: "yes",
        stoppedWork: [{ name: "ok", kind: "background" }, { name: 3 }],
        moreStoppedWork: -1
      },
      backgroundWorkLive: "maybe",
      autoContinues: [{ turnId: "turn-2", at: "a" }, "junk"]
    });
    const marker = parsed.continueAfterRestart;
    assert.deepEqual(
      [marker?.turnId, marker?.revival, marker?.stoppedWork, marker?.moreStoppedWork],
      ["turn-1", undefined, [{ name: "ok", kind: "background" }], undefined]
    );
    assert.equal(parsed.backgroundWorkLive, undefined);
    assert.deepEqual(parsed.autoContinues, [{ turnId: "turn-2", at: "a" }]);
  });
});
