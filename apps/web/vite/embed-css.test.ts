import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import postcss from "postcss";
import { bodyFontStack, embedCssVariables, embedShadowCss } from "./embed-css";

async function shadow(css: string): Promise<string> {
  const result = await postcss([embedShadowCss({ rootClass: "orq-embed-root" })]).process(css, { from: undefined });
  return result.css;
}

describe("embedShadowCss", () => {
  it("moves document selectors to the shadow host and the wrapper", async () => {
    assert.equal(await shadow(":root, [data-mode=\"dark\"] { color: red }"), ":host,\n[data-mode=\"dark\"] { color: red }");
    assert.equal(await shadow("html, :host { line-height: 1.5 }"), ":host { line-height: 1.5 }");
    assert.equal(await shadow("body { margin: 0 }"), ".orq-embed-root { margin: 0 }");
    assert.equal(await shadow(":root[data-x] .a, html > body p { color: red }"), ":host([data-x]) .a,\n:host > .orq-embed-root p { color: red }");
  });

  it("leaves selectors that only contain the words alone", async () => {
    const css = ".html-view, .body, [data-body] a, #root { color: red }\n@keyframes k { from { opacity: 0 } }";
    assert.equal(await shadow(css), css);
  });

  it("makes theme variables overridable through --orq-* and leaves the others", async () => {
    const out = await shadow(
      "[data-mode=\"light\"] { --n-50: 9 9 11; --sem-ok-70-muted: 2 44 34; --diff-add-bg: rgb(220 252 231); --git-added: rgb(21 128 61); --ac-x: 1 }"
    );
    assert.equal(
      out,
      "[data-mode=\"light\"] { --n-50: var(--orq-n-50, 9 9 11); --sem-ok-70-muted: var(--orq-sem-ok-70-muted, 2 44 34); " +
        "--diff-add-bg: var(--orq-diff-add-bg, rgb(220 252 231)); --git-added: rgb(21 128 61); --ac-x: 1 }"
    );
  });

  it("puts the body font behind --orq-font-sans", async () => {
    assert.equal(
      await shadow("body { font-family: Inter, sans-serif } .a { font-family: serif }"),
      ".orq-embed-root { font-family: var(--orq-font-sans, Inter, sans-serif) } .a { font-family: serif }"
    );
  });
});

describe("the --orq-* contract", () => {
  const globals = readFileSync(new URL("../../../packages/ui/src/styles/globals.css", import.meta.url), "utf8");

  it("is documented exactly in docs/embed-agent-chat.md", () => {
    const doc = readFileSync(new URL("../../../docs/embed-agent-chat.md", import.meta.url), "utf8");
    const section = /^## CSS variables\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(doc);
    assert.ok(section, "docs/embed-agent-chat.md has a \"## CSS variables\" section");
    const documented = [...section[1].matchAll(/`(--orq-[\w-]+)`/g)].map((match) => match[1]);
    assert.deepEqual([...documented].sort(), [...embedCssVariables(globals)].sort());
    assert.equal(new Set(documented).size, documented.length, "no variable is listed twice");
  });

  it("takes the font default from the app's body", () => {
    assert.match(bodyFontStack(globals), /^Inter, .*sans-serif$/);
  });
});
