import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveMarkdownImageSource } from "./local-image.ts";

const ROOT = "/srv/workspaces/team/game";

describe("resolveMarkdownImageSource", () => {
  it("joins a project-relative path onto the project root", () => {
    assert.deepEqual(resolveMarkdownImageSource("build/shots/final.png", ROOT), {
      kind: "local",
      path: "/srv/workspaces/team/game/build/shots/final.png"
    });
    assert.deepEqual(resolveMarkdownImageSource("./shots/../a%20b.png", ROOT), {
      kind: "local",
      path: "/srv/workspaces/team/game/a b.png"
    });
  });

  it("keeps an absolute host path and drops a query or fragment", () => {
    assert.deepEqual(resolveMarkdownImageSource("/tmp//x/./shot.png?v=2", ROOT), {
      kind: "local",
      path: "/tmp/x/shot.png"
    });
    assert.deepEqual(resolveMarkdownImageSource("/tmp/shot.png", undefined), { kind: "local", path: "/tmp/shot.png" });
  });

  it("leaves URLs to the browser", () => {
    for (const src of ["https://example.com/a.png", "//cdn.example.com/a.png", "data:image/png;base64,AA"]) {
      assert.deepEqual(resolveMarkdownImageSource(src, ROOT), { kind: "remote", src });
    }
  });

  it("cannot place a relative path without a project, nor a home-relative one", () => {
    assert.deepEqual(resolveMarkdownImageSource("shot.png", undefined), { kind: "unresolved", src: "shot.png" });
    assert.deepEqual(resolveMarkdownImageSource("~/shot.png", ROOT), { kind: "unresolved", src: "~/shot.png" });
    assert.deepEqual(resolveMarkdownImageSource("", ROOT), { kind: "unresolved", src: "" });
  });
});
