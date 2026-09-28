/**
 * The inspector's per-block state never carries over to another block: the
 * name field, the settings body and the Data tab are keyed by the block, so a
 * pin editor's text, a field's draft and a CodeMirror undo stack start fresh.
 * Pinned in the source (the inspector needs a live editor to render).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Inspector.tsx"), "utf8");

describe("the inspector body is keyed by the block", () => {
  for (const element of ["<NameField key={node.id}", "<fieldset key={node.id}", "<DataTab key={node.id}"]) {
    it(element, () => assert.ok(source.includes(element), `${element} is keyed by node.id`));
  }
});
