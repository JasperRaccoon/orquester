import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { createMermaidSvgSanitizer, standaloneSvg } from "./mermaid-svg.ts";

const dom = new JSDOM("<!doctype html><body></body>");
const win = dom.window as unknown as Window & typeof globalThis;
const sanitize = createMermaidSvgSanitizer(win);

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50">${inner}</svg>`;

describe("mermaid SVG sanitiser", () => {
  it("keeps an ordinary diagram intact, label text included", () => {
    const out = sanitize(
      wrap(
        '<style>#m .node rect{fill:#222;stroke:#999}</style><g class="node"><rect width="10" height="10"/><text x="1" y="2">Start &amp; stop</text></g>' +
          '<defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><path marker-end="url(#arrow)" d="M0 0L9 9"/>'
      )
    );
    assert.ok(out.includes("Start &amp; stop"), out);
    assert.ok(out.includes('marker-end="url(#arrow)"'), out);
    assert.ok(out.includes("<rect"), out);
    assert.ok(out.includes("fill:#222"), out);
  });

  it("drops script, event handlers, links and images", () => {
    const out = sanitize(
      wrap(
        '<script>alert(1)</script><rect onload="alert(2)" width="1" height="1"/>' +
          '<a href="https://evil.example/"><text>link</text></a>' +
          '<a xlink:href="javascript:alert(3)"><text>js</text></a>' +
          '<image href="https://evil.example/x.png"/><img src="https://evil.example/y.png"/>'
      )
    );
    assert.ok(!/<script/i.test(out), out);
    assert.ok(!/onload/i.test(out), out);
    assert.ok(!/<a[\s>]/i.test(out), out);
    assert.ok(!/<image/i.test(out), out);
    assert.ok(!/<img/i.test(out), out);
    assert.ok(!out.includes("evil.example"), out);
    assert.ok(!out.includes("javascript:"), out);
  });

  it("strips src and srcset anywhere", () => {
    const out = sanitize(wrap('<foreignObject><div><video src="https://evil.example/v.mp4"></video></div></foreignObject>'));
    assert.ok(!out.includes("evil.example"), out);
    assert.ok(!/\ssrc=/.test(out), out);
  });

  it("removes href and xlink:href on any element", () => {
    const out = sanitize(
      wrap('<defs><g id="n"/></defs><use href="#n"/><use xlink:href="https://evil.example/sprite.svg#n"/><rect href="#n"/>')
    );
    assert.ok(!/href=/.test(out), out);
    assert.ok(!out.includes("evil.example"), out);
  });

  it("neutralises remote url() in style elements and attributes, keeping local references", () => {
    const out = sanitize(
      wrap(
        "<style>.a{background:url(https://evil.example/a.png)} .b{fill:url(#grad)} @import url('https://evil.example/c.css');</style>" +
          '<rect style="fill:url(//evil.example/b.png);stroke:url(#grad)" width="1" height="1"/>'
      )
    );
    assert.ok(!out.includes("evil.example"), out);
    assert.ok(out.includes("url(#grad)"), out);
  });
});

const env = { DOMParser: win.DOMParser, XMLSerializer: win.XMLSerializer };

/** The expanded image is a standalone XML document: it must parse as one. */
function parsesAsXml(markup: string): { ok: boolean; doc: Document } {
  const doc = new win.DOMParser().parseFromString(markup, "image/svg+xml");
  return { ok: doc.getElementsByTagName("parsererror").length === 0, doc };
}

describe("standalone SVG for the expanded viewer", () => {
  it("fixes the size from the viewBox and sets an opaque background", () => {
    const markup = standaloneSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320 180" style="max-width: 320px;"><rect/></svg>',
      env,
      "rgb(10, 10, 10)"
    );
    assert.ok(markup.includes('width="320"'), markup);
    assert.ok(markup.includes('height="180"'), markup);
    assert.ok(markup.includes("background-color:rgb(10, 10, 10)"), markup);
    assert.ok(markup.includes("max-width:none"), markup);
    assert.ok(markup.includes('xmlns="http://www.w3.org/2000/svg"'), markup);
    assert.equal(parsesAsXml(markup).ok, true, markup);
  });

  it("survives a non-breaking space in a label (HTML output, XML document)", () => {
    // DOMPurify serialises U+00A0 as `&nbsp;`, which an XML parser rejects.
    const sanitized = sanitize(wrap('<text x="1" y="2">a\u00a0b</text>'));
    assert.ok(sanitized.includes("&nbsp;"), "precondition: the sanitiser emits an HTML entity");
    const markup = standaloneSvg(sanitized, env, "rgb(0, 0, 0)");
    const { ok, doc } = parsesAsXml(markup);
    assert.equal(ok, true, markup);
    assert.equal(doc.getElementsByTagName("text")[0]?.textContent, "a\u00a0b");
  });

  it("keeps labels with other HTML-only output well-formed", () => {
    const sanitized = sanitize(wrap('<style>.n{fill:#fff}</style><text>x &lt; y &amp; z</text><rect width="1" height="1"/>'));
    const { ok, doc } = parsesAsXml(standaloneSvg(sanitized, env, "#000"));
    assert.equal(ok, true);
    assert.equal(doc.getElementsByTagName("text")[0]?.textContent, "x < y & z");
  });

  it("throws, so the viewer can show an error, when there is no SVG", () => {
    assert.throws(() => standaloneSvg("<p>not a diagram</p>", env, "#000"), /could not be prepared/);
    assert.throws(() => standaloneSvg("", env, "#000"), /could not be prepared/);
  });
});
