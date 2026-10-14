/**
 * Publishing an agent page (spec 2026-10-14 §2.1, §2.2). Image cases derived
 * from T3 Code (MIT): `apps/server/src/htmlRender/HtmlRender.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { htmlRenderReferenceOfActivityPayload } from "@orquester/api/agent-chat";

import {
  HTML_RENDER_MAX_IMAGE_BYTES,
  HtmlRenderPublishError,
  isImageBytes,
  openInsideRoot,
  publishHtmlRender,
  type HtmlRenderPublishDeps
} from "./html-render-publish.ts";

const PAGE_ID = "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

interface Stored {
  threadId: string;
  fileName: string;
  html: string;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "orq-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  const stored: Stored[] = [];
  const deps: HtmlRenderPublishDeps = {
    storeAttachment: async (threadId, fileName, bytes) => {
      stored.push({ threadId, fileName, html: bytes.toString("utf8") });
      return PAGE_ID;
    },
    sandboxRoot: async () => project
  };
  return { project, outside, stored, deps };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof HtmlRenderPublishError ? error.code : undefined;
}

test("publish stores the page with the bootstrap and answers the reference", async (t) => {
  const { stored, deps } = await fixture(t);
  const reference = await publishHtmlRender(deps, {
    threadId: "t1",
    html: "<h1>Hi</h1>",
    title: "  Quarterly chart  ",
    height: 5000
  });
  assert.deepEqual(reference, { attachmentId: PAGE_ID, title: "Quarterly chart", height: 2000 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.fileName, "Quarterly chart.html");
  assert.ok(stored[0]!.html.includes('<style id="orq-theme">'));
  assert.ok(stored[0]!.html.endsWith("<h1>Hi</h1>"));
});

test("the reference the publisher answers is what every client reads back from the tool row", async (t) => {
  const { deps } = await fixture(t);
  const reference = await publishHtmlRender(deps, {
    threadId: "t1",
    html: "<p>x</p>",
    title: "T",
    height: 300,
    heights: [
      [728, 280],
      [320, 400]
    ]
  });
  // As the host's ingestion persists it: the session-tool provenance marker stamped.
  const row = {
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      toolName: "mcp__orquester__html_render",
      sessionTool: { name: "html_render" },
      result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ htmlRender: reference, message: "m" }) }] }
    }
  };
  assert.deepEqual(htmlRenderReferenceOfActivityPayload(row), reference);
  assert.deepEqual(reference.heights, [
    [320, 400],
    [728, 280]
  ]);
});

test("measure runs on the prepared page when no heights were given; a throw publishes without", async (t) => {
  const { deps } = await fixture(t);
  let measured = "";
  const withHeights = await publishHtmlRender(deps, {
    threadId: "t1",
    html: "<p>x</p>",
    title: "T",
    height: 300,
    measure: async (html) => {
      measured = html;
      return [[728, 222]];
    }
  });
  assert.ok(measured.includes('<style id="orq-theme">'));
  assert.deepEqual(withHeights.heights, [[728, 222]]);
  const without = await publishHtmlRender(deps, {
    threadId: "t1",
    html: "<p>x</p>",
    title: "T",
    height: 300,
    measure: async () => {
      throw new Error("no browser");
    }
  });
  assert.equal(without.heights, undefined);
});

test("a local image inside the project is inlined as a data URI", async (t) => {
  const { project, stored, deps } = await fixture(t);
  const image = join(project, "chart.png");
  await writeFile(image, PNG);
  await publishHtmlRender(deps, {
    threadId: "t1",
    html: `<img src="${image}"><div style="background:url(${image})"></div>`,
    title: "T",
    height: 200
  });
  const html = stored[0]!.html;
  assert.ok(!html.includes(image), "no local path is left in the page");
  assert.equal(html.split(`data:image/png;base64,${PNG.toString("base64")}`).length - 1, 2);
});

test("an image outside the project is refused, symlinked in or not", async (t) => {
  const { project, outside, stored, deps } = await fixture(t);
  const secret = join(outside, "secret.png");
  await writeFile(secret, PNG);
  const link = join(project, "linked.png");
  await symlink(secret, link);
  for (const path of [secret, link]) {
    await assert.rejects(
      publishHtmlRender(deps, { threadId: "t1", html: `<img src="${path}">`, title: "T", height: 200 }),
      (error) => errorCode(error) === "images-outside-project",
      path
    );
  }
  // And a thread with no project inlines nothing at all.
  const noProject = { ...deps, sandboxRoot: async () => null };
  await assert.rejects(
    publishHtmlRender(noProject, { threadId: "t1", html: `<img src="${join(project, "x.png")}">`, title: "T", height: 200 }),
    (error) => errorCode(error) === "images-not-found" || errorCode(error) === "images-outside-project"
  );
  assert.equal(stored.length, 0, "a refusal stores nothing");
});

test("a missing image, or a file that is not an image whatever its name, is refused", async (t) => {
  const { project, deps } = await fixture(t);
  const fake = join(project, "fake.png");
  await writeFile(fake, "API_KEY=hunter2\n");
  for (const path of [join(project, "missing.png"), fake]) {
    await assert.rejects(
      publishHtmlRender(deps, { threadId: "t1", html: `<img src='${path}'>`, title: "T", height: 200 }),
      (error) => errorCode(error) === "images-not-found" && (error as Error).message.includes(path),
      path
    );
  }
});

test("an image over 10 MiB is refused", async (t) => {
  const { project, deps } = await fixture(t);
  const big = join(project, "big.png");
  await writeFile(big, Buffer.concat([PNG, Buffer.alloc(HTML_RENDER_MAX_IMAGE_BYTES)]));
  await assert.rejects(
    publishHtmlRender(deps, { threadId: "t1", html: `<img src="${big}">`, title: "T", height: 200 }),
    (error) => errorCode(error) === "image-too-large"
  );
});

test("a page over 25 MiB once its images are inlined is refused", async (t) => {
  const { project, deps } = await fixture(t);
  const images = await Promise.all(
    [1, 2, 3].map(async (index) => {
      const file = join(project, `i${index}.png`);
      await writeFile(file, Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]));
      return file;
    })
  );
  await assert.rejects(
    publishHtmlRender(deps, {
      threadId: "t1",
      html: images.map((file) => `<img src="${file}">`).join(""),
      title: "T",
      height: 200
    }),
    (error) => errorCode(error) === "page-too-large"
  );
});

test("an empty or oversized page, or a store failure, is refused with a code", async (t) => {
  const { deps } = await fixture(t);
  await assert.rejects(
    publishHtmlRender(deps, { threadId: "t1", html: "   ", title: "T", height: 200 }),
    (error) => errorCode(error) === "invalid-input"
  );
  await assert.rejects(
    publishHtmlRender(deps, { threadId: "t1", html: "x".repeat(512_001), title: "T", height: 200 }),
    (error) => errorCode(error) === "invalid-input"
  );
  await assert.rejects(
    publishHtmlRender(
      { ...deps, storeAttachment: async () => Promise.reject(new Error("host down")) },
      { threadId: "t1", html: "<p>x</p>", title: "T", height: 200 }
    ),
    (error) => errorCode(error) === "store-failed" && (error as Error).message.includes("host down")
  );
  await assert.rejects(
    publishHtmlRender(
      { ...deps, storeAttachment: async () => "t1-0f8fad5b-d9cb-469f-a165-70867728950e-bin" },
      { threadId: "t1", html: "<p>x</p>", title: "T", height: 200 }
    ),
    (error) => errorCode(error) === "store-failed"
  );
});

test("image sniffing reads magic bytes and SVG roots, not names", () => {
  assert.ok(isImageBytes(PNG));
  assert.ok(isImageBytes(Buffer.from("GIF89a")));
  assert.ok(isImageBytes(Buffer.from('<?xml version="1.0"?><!-- c --><svg xmlns="x"></svg>')));
  assert.ok(!isImageBytes(Buffer.from("<html><svg></svg></html>")));
  assert.ok(!isImageBytes(Buffer.from("plain text")));
});

test("an image path swapped for a symlink after its realpath was checked cannot be read", async (t) => {
  // `openInsideRoot` is what runs after the realpath check: hand it the paths
  // a swap would leave behind and it must refuse every one of them.
  const { project, outside } = await fixture(t);
  const inside = join(project, "ok.png");
  await writeFile(inside, PNG);
  const secret = join(outside, "secret.png");
  await writeFile(secret, PNG);
  const ok = await openInsideRoot(inside, project);
  assert.ok(ok, "a real file inside the project opens");
  await ok.close();
  // The last component swapped for a symlink out of the project.
  const swappedFile = join(project, "swapped.png");
  await symlink(secret, swappedFile);
  assert.equal(await openInsideRoot(swappedFile, project), null);
  // A directory on the way swapped for a symlink out of the project.
  const swappedDir = join(project, "assets");
  await symlink(outside, swappedDir);
  assert.equal(await openInsideRoot(join(swappedDir, "secret.png"), project), null);
  // Plainly outside.
  assert.equal(await openInsideRoot(secret, project), null);
});
