import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { absoluteUrls, splitFontFaces } from "./font-faces";

describe("splitFontFaces", () => {
  it("takes the @font-face rules out of the stylesheet", () => {
    const css =
      '.katex{font:normal 1.21em KaTeX_Main}@font-face{font-family:KaTeX_AMS;src:url(a.woff2) format("woff2")}' +
      ".katex .mord{color:red}@font-face { font-family: KaTeX_Main; src: url(b.woff2) }";
    assert.deepEqual(splitFontFaces(css), {
      fontFaces: '@font-face{font-family:KaTeX_AMS;src:url(a.woff2) format("woff2")}\n@font-face { font-family: KaTeX_Main; src: url(b.woff2) }',
      rules: ".katex{font:normal 1.21em KaTeX_Main}.katex .mord{color:red}"
    });
  });

  it("returns a stylesheet without font faces unchanged", () => {
    assert.deepEqual(splitFontFaces(".a{color:red}"), { fontFaces: "", rules: ".a{color:red}" });
  });
});

describe("absoluteUrls", () => {
  const base = "https://orq.example.com/embed/agent-chat.abc.js";

  it("resolves relative font URLs against the bundle's URL", () => {
    assert.equal(
      absoluteUrls("src:url(fonts/a.woff2),url('../b.woff'),url(\"/c.ttf\")", base),
      'src:url("https://orq.example.com/embed/fonts/a.woff2"),url("https://orq.example.com/b.woff"),url("https://orq.example.com/c.ttf")'
    );
  });

  it("keeps absolute and data URLs", () => {
    const css = 'src:url("https://cdn.example.com/a.woff2"),url(data:font/woff2;base64,AA==),url(//x.example/b.woff)';
    assert.equal(absoluteUrls(css, base), css);
  });
});
