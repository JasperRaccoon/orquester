import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { decodeDataFrame, parseControlMessage } from "@orquester/api";

import { BOX_AGENT_SOURCE_DIR } from "./build.ts";
import { FIXTURES } from "./fixtures.ts";

const fixturePath = (name: string): string => join(BOX_AGENT_SOURCE_DIR, "fixtures", `${name}.json`);

// The JSON form of a typed value (drops `undefined`, as the wire does).
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("golden fixtures match the typed TypeScript values (UPDATE_FIXTURES=1 rewrites them)", async () => {
  for (const [name, value] of Object.entries(FIXTURES)) {
    if (process.env.UPDATE_FIXTURES === "1") {
      await writeFile(fixturePath(name), `${JSON.stringify(value, null, 2)}\n`);
    }
    const onDisk: unknown = JSON.parse(await readFile(fixturePath(name), "utf8"));
    assert.deepEqual(onDisk, asJson(value), `fixtures/${name}.json is stale; run with UPDATE_FIXTURES=1`);
  }
});

test("golden control and frame bytes decode without losing data", async () => {
  const controls = JSON.parse(await readFile(fixturePath("control"), "utf8")) as Record<string, unknown[]>;
  for (const samples of Object.values(controls)) {
    for (const sample of samples) assert.deepEqual(parseControlMessage(JSON.stringify(sample)), sample);
  }
  const frames = JSON.parse(await readFile(fixturePath("frames"), "utf8")) as Array<{ channel: number; stream: number; payloadHex: string; frameHex: string }>;
  for (const frame of frames) {
    const decoded = decodeDataFrame(Buffer.from(frame.frameHex, "hex"));
    assert.equal(decoded.channel, frame.channel);
    assert.equal(decoded.stream, frame.stream);
    assert.equal(Buffer.from(decoded.payload).toString("hex"), frame.payloadHex);
  }
});
