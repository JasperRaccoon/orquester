import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { createDiagramSanitizers, standaloneSvg } from "./mermaid-svg.ts";

const dom = new JSDOM("<!doctype html><body></body>");
const win = dom.window as unknown as Window & typeof globalThis;
const sanitizers = createDiagramSanitizers(win);

/** The sanitised fragment as markup. */
function markup(node: Node): string {
  const host = win.document.createElement("div");
  host.append(node);
  return host.innerHTML;
}
const plain = (svg: string): string => markup(sanitizers.plain(svg));
const math = (svg: string): string => markup(sanitizers.math(svg));

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="pele" viewBox="0 0 100 50" style="--_fg:var(--pele-fg,#1f1f1f);color:var(--_fg)">${inner}</svg>`;

// The styled rect comes first: an HTML-only tag such as `<img>` ends the SVG
// for the HTML parser, and what follows it is no longer SVG.
const HOSTILE =
  '<rect style="fill:url(//evil.example/b.png);stroke:url(#grad)" width="1" height="1"/>' +
  '<script>alert(1)</script><rect onload="alert(2)" width="1" height="1"/>' +
  '<a href="https://evil.example/"><text>link</text></a>' +
  '<a xlink:href="javascript:alert(3)"><text>js</text></a>' +
  "<style>.a{background:url(https://evil.example/a.png)}</style>" +
  '<use href="https://evil.example/sprite.svg#n"/><rect href="#n"/>' +
  '<image href="https://evil.example/x.png"/><img src="https://evil.example/y.png"/>';

function assertHostileGone(out: string): void {
  assert.ok(!/<script/i.test(out), out);
  assert.ok(!/onload/i.test(out), out);
  assert.ok(!/<a[\s>]/i.test(out), out);
  assert.ok(!/<image/i.test(out), out);
  assert.ok(!/<img/i.test(out), out);
  assert.ok(!/<style/i.test(out), out);
  assert.ok(!/href=/.test(out), out);
  assert.ok(!out.includes("evil.example"), out);
  assert.ok(!out.includes("javascript:"), out);
}

describe("diagram SVG sanitiser (no math)", () => {
  it("keeps a pele diagram intact: shapes, label text, CSS variables", () => {
    const out = plain(
      wrap(
        '<g class="pele-node" data-id="A" transform="translate(32,76)"><rect width="48" height="48" fill="var(--_s)" style="rx:var(--_r)"/>' +
          '<text class="pele-label" text-anchor="middle"><tspan x="0" y="5.6">Start &amp; stop</tspan></text></g>' +
          '<path class="pele-marker" d="M104,32L96,35Z" fill="var(--_l)"/>'
      )
    );
    assert.ok(out.includes("Start &amp; stop"), out);
    assert.ok(out.includes('fill="var(--_s)"'), out);
    assert.ok(out.includes("--_fg:var(--pele-fg,#1f1f1f)"), out);
    assert.ok(out.includes("<tspan"), out);
  });

  it("drops script, handlers, links, images, styles and every reference attribute", () => {
    const out = plain(wrap(HOSTILE));
    assertHostileGone(out);
    assert.ok(out.includes("url(#grad)"), "a local reference stays");
  });

  it("drops foreignObject entirely, HTML or MathML inside it", () => {
    const out = plain(wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><math><mi>x</mi></math><video src="https://evil.example/v.mp4"></video></div></foreignObject>'));
    assert.ok(!/foreignObject|<math|<video/i.test(out), out);
    assert.ok(!out.includes("evil.example"), out);
  });
});

describe("diagram SVG sanitiser (math labels)", () => {
  const label = (inner: string): string =>
    wrap(
      `<foreignObject class="pele-math" x="-10" y="-5" width="20" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex">${inner}</div></foreignObject>`
    );

  it("keeps KaTeX's MathML and its presentation attributes", () => {
    const out = math(
      label(
        '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo stretchy="false" lspace="0em">+</mo><mfrac linethickness="0px"><mn>1</mn><mn>2</mn></mfrac></mrow></semantics></math>'
      )
    );
    assert.ok(out.includes("<foreignObject"), out);
    assert.ok(out.includes("<math"), out);
    assert.ok(out.includes("<msup>"), out);
    assert.ok(out.includes('stretchy="false"'), out);
    assert.ok(out.includes('lspace="0em"'), out);
    assert.ok(out.includes('linethickness="0px"'), out);
  });

  it("drops what KaTeX never emits: annotations, glyph images, links and unknown attributes", () => {
    const out = math(
      label(
        '<math><semantics><mrow><mi onclick="alert(1)" href="https://evil.example/">x</mi><mglyph src="https://evil.example/g.png"/></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math>'
      )
    );
    assert.ok(out.includes("<mi>x</mi>"), out);
    assert.ok(!/annotation|mglyph|onclick/i.test(out), out);
    assert.ok(!out.includes("evil.example"), out);
  });

  it("drops the same hostile markup as the plain profile, HTML inside the label included", () => {
    assertHostileGone(math(wrap(HOSTILE)));
    const out = math(label('<img src="https://evil.example/x.png"><a href="https://evil.example/">x</a><script>alert(1)</script><iframe src="https://evil.example/"></iframe>'));
    assert.ok(!/<img|<a[\s>]|<script|<iframe/i.test(out), out);
    assert.ok(!out.includes("evil.example"), out);
  });
});

/** The expanded image is a standalone XML document: it must parse as one. */
function parsesAsXml(text: string): { ok: boolean; doc: Document } {
  const doc = new win.DOMParser().parseFromString(text, "image/svg+xml");
  return { ok: doc.getElementsByTagName("parsererror").length === 0, doc };
}

function mounted(inner: string, style = ""): SVGSVGElement {
  const host = win.document.createElement("div");
  host.setAttribute("style", style);
  win.document.body.replaceChildren(host);
  host.append(sanitizers.math(wrap(inner)));
  return host.querySelector("svg") as unknown as SVGSVGElement;
}

const env = { getComputedStyle: (element: Element) => win.getComputedStyle(element), XMLSerializer: win.XMLSerializer };

describe("standalone SVG for the expanded viewer", () => {
  it("fixes the size from the viewBox, sets an opaque background and leaves the mounted SVG alone", () => {
    const svg = mounted('<rect width="1" height="1"/>');
    const text = standaloneSvg(svg, env, "rgb(10, 10, 10)");
    assert.ok(text.includes('width="100"'), text);
    assert.ok(text.includes('height="50"'), text);
    assert.ok(text.includes("background-color: rgb(10, 10, 10)"), text);
    assert.ok(text.includes("max-width: none"), text);
    assert.ok(text.includes('xmlns="http://www.w3.org/2000/svg"'), text);
    assert.equal(parsesAsXml(text).ok, true, text);
    assert.equal(svg.getAttribute("width"), null, "the mounted copy is untouched");
  });

  it("writes the page's resolved --pele-* colours onto the copy, which an image cannot inherit", () => {
    const svg = mounted('<rect width="1" height="1"/>');
    // jsdom does not inherit custom properties; a browser resolves them from `.ac-mermaid`.
    const resolved: Record<string, string> = {
      "--pele-fg": "rgb(1, 2, 3)",
      "--pele-series-3": "rgb(4, 5, 6)",
      "--pele-font": "inherit",
      "font-family": "Inter"
    };
    const computed = { getPropertyValue: (name: string) => resolved[name] ?? "" } as CSSStyleDeclaration;
    const text = standaloneSvg(svg, { ...env, getComputedStyle: () => computed }, "#000");
    assert.ok(text.includes("--pele-fg: rgb(1, 2, 3)"), text);
    assert.ok(text.includes("--pele-series-3: rgb(4, 5, 6)"), text);
    assert.ok(text.includes("--pele-font: Inter"), text);
    assert.ok(!text.includes("--pele-font: inherit"), text);
  });

  it("keeps labels with entities and MathML well-formed", () => {
    const svg = mounted(
      '<text>a b x &lt; y &amp; z</text><foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml"><math><mi>x</mi></math></div></foreignObject>'
    );
    const { ok, doc } = parsesAsXml(standaloneSvg(svg, env, "#000"));
    assert.equal(ok, true);
    assert.equal(doc.getElementsByTagName("text")[0]?.textContent, "a b x < y & z");
  });
});
