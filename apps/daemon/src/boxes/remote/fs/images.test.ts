import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HtmlRenderPublishError, inlineLocalImages, prepareHtmlRender } from "../../../agent-chat/html-render-publish.ts";
import { boxImageReader } from "./images.ts";
import { boxDiskConnection, fakeBoxRegistry } from "./test-box.ts";

// html_render / html_preview image inlining for a box project: images are read in the box, only from inside the project.

const PROJECT = "/ws/acme/engine";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);

async function setup(t: test.TestContext, windows = false) {
  const disk = await realpath(await mkdtemp(join(tmpdir(), "orq-box-images-")));
  t.after(() => rm(disk, { recursive: true, force: true }));
  const connection = boxDiskConnection({ disk, windows });
  const registry = fakeBoxRegistry({ projectPath: PROJECT, connection });
  const boxPath = (host: string): string => (windows ? `C:\\orq${host.split("/").join("\\")}` : host);
  const local = (host: string): string => connection.local(boxPath(host));
  await mkdir(local(`${PROJECT}/assets`), { recursive: true });
  await writeFile(local(`${PROJECT}/assets/logo.png`), PNG);
  await mkdir(local("/etc"), { recursive: true });
  await writeFile(local("/etc/secret.png"), PNG);
  await symlink(local("/etc/secret.png"), local(`${PROJECT}/assets/leak.png`));
  await writeFile(local(`${PROJECT}/assets/fake.png`), "TOKEN=not an image");
  return { connection, registry, boxPath };
}

test("box images inside the project are inlined; links out, missing files and non-images are not", async (t) => {
  const { registry, connection } = await setup(t);
  const reader = boxImageReader(registry, PROJECT);
  assert.ok(reader, "a box project gets a box reader");
  const root = await reader.realpath(PROJECT);
  assert.equal(root, PROJECT);
  const html = `<img src="${PROJECT}/assets/logo.png"><img src="${PROJECT}/assets/leak.png"><img src="${PROJECT}/assets/none.png"><img src="${PROJECT}/assets/fake.png">`;
  const result = await inlineLocalImages(html, root, reader);
  assert.match(result.html, new RegExp(`data:image/png;base64,${PNG.toString("base64")}`));
  assert.deepEqual(result.outside, [`${PROJECT}/assets/leak.png`]);
  assert.deepEqual(result.missing.sort(), [`${PROJECT}/assets/fake.png`, `${PROJECT}/assets/none.png`]);
  assert.ok(connection.calls.some((call) => call.method === "fs.realpath"), "resolved in the box");

  await assert.rejects(prepareHtmlRender(html, root, reader), (error: unknown) => error instanceof HtmlRenderPublishError && error.code === "images-outside-project");
});

test("a Windows box's agent names images by box paths; they map to the project", async (t) => {
  const { registry, boxPath } = await setup(t, true);
  const reader = boxImageReader(registry, PROJECT)!;
  const root = await reader.realpath(PROJECT);
  assert.equal(root, PROJECT);
  const reference = boxPath(`${PROJECT}/assets/logo.png`);
  const result = await inlineLocalImages(`<img src="${reference}">`, root, reader);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.outside, []);
  assert.match(result.html, /data:image\/png;base64,/);
});

test("host projects keep the host reader; an unreachable box resolves no image", async (t) => {
  const { registry, connection } = await setup(t);
  assert.equal(boxImageReader(registry, "/ws/acme/host-project"), undefined);
  assert.equal(boxImageReader(undefined, PROJECT), undefined);
  connection.setConnected(false);
  const reader = boxImageReader(registry, PROJECT)!;
  const result = await inlineLocalImages(`<img src="${PROJECT}/assets/logo.png">`, PROJECT, reader);
  assert.deepEqual(result.missing, [`${PROJECT}/assets/logo.png`]);
});
