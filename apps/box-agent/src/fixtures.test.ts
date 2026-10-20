import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { decodeDataFrame, parseControlMessage } from "@orquester/api";

import { BOX_AGENT_SOURCE_DIR } from "./build.ts";
import { controlFixture, FIXTURES, framesFixture } from "./fixtures.ts";

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

test("every control fixture parses as a control message of its type", () => {
  for (const [t, samples] of Object.entries(controlFixture)) {
    assert.ok(samples.length > 0, `no sample for ${t}`);
    for (const sample of samples) {
      const parsed = parseControlMessage(JSON.stringify(sample));
      assert.equal(parsed?.t, t);
    }
  }
});

test("frame fixtures decode back to their payloads", () => {
  for (const frame of framesFixture) {
    const decoded = decodeDataFrame(Buffer.from(frame.frameHex, "hex"));
    assert.equal(decoded.channel, frame.channel);
    assert.equal(decoded.stream, frame.stream);
    assert.equal(Buffer.from(decoded.payload).toString("hex"), frame.payloadHex);
  }
});
