import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultSavedImagePath,
  normalizeProjectRelativePath,
  writeWithoutOverwrite,
  type ExclusiveWriteResult
} from "./chat-images.logic.ts";

/** A project holding `taken`: a write claims a free name and refuses a taken one, as the upload route does. */
function project(taken: string[]) {
  const files = new Set(taken);
  const asked: string[] = [];
  const write = async (path: string): Promise<ExclusiveWriteResult> => {
    asked.push(path);
    if (files.has(path)) return { conflict: true };
    files.add(path);
    return { conflict: false, path: `/w/ws/app/${path}` };
  };
  return { write, asked };
}

describe("Save to project: never overwrite", () => {
  it("saves under the name asked for when it is free", async () => {
    const { write, asked } = project(["assets/generated/other.png"]);
    assert.equal(await writeWithoutOverwrite("assets/generated/dog.png", write), "/w/ws/app/assets/generated/dog.png");
    assert.deepEqual(asked, ["assets/generated/dog.png"]);
  });

  it("takes the next free -vN name before the extension when the name is taken", async () => {
    const { write } = project(["assets/dog.png", "assets/dog-v2.png"]);
    assert.equal(await writeWithoutOverwrite("assets/dog.png", write), "/w/ws/app/assets/dog-v3.png");
    // A name without an extension, and a dotted folder, version the file's own name.
    const other = project(["notes.d/LICENSE"]);
    assert.equal(await writeWithoutOverwrite("notes.d/LICENSE", other.write), "/w/ws/app/notes.d/LICENSE-v2");
  });

  it("gives up rather than replace a file when every name is taken", async () => {
    const { write, asked } = project(["a.png", "a-v2.png", "a-v3.png"]);
    await assert.rejects(writeWithoutOverwrite("a.png", write, 3));
    assert.deepEqual(asked, ["a.png", "a-v2.png", "a-v3.png"]);
  });
});

describe("Save to project: the path", () => {
  it("proposes the generated-images folder, a slug of the caption, and the image's extension", () => {
    assert.equal(
      defaultSavedImagePath({ caption: "A dog in the snow, at dawn!", mimeType: "image/jpeg" }),
      "assets/generated/a-dog-in-the-snow-at-dawn.jpg"
    );
    assert.equal(defaultSavedImagePath({ title: "Café menu" }), "assets/generated/cafe-menu.png");
    assert.equal(defaultSavedImagePath({ caption: "😀" }), "assets/generated/image.png");
  });

  it("takes a path inside the project and refuses one that leaves it", () => {
    assert.equal(normalizeProjectRelativePath(" ./assets//img/./dog.png "), "assets/img/dog.png");
    for (const outside of ["", "/etc/passwd", "~/dog.png", "../dog.png", "assets/../../dog.png", "assets/", "C:/dog.png"]) {
      assert.equal(normalizeProjectRelativePath(outside), null, outside);
    }
  });
});
