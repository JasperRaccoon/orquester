// Adapted from T3 Code (MIT): apps/web/src/components/chat/MermaidDiagram.tsx
// (the two DOMPurify profiles, the KaTeX MathML allowlist and the standalone-SVG blob).

import DOMPurify from "dompurify";

/**
 * What happens to a diagram's SVG between pele and the page (spec §4).
 *
 * Diagram source is untrusted model output. Pele escapes label text, and the
 * chat mounts it with links and images off; this is the second line: strip
 * anything that can navigate, run script or fetch remote content, whatever
 * pele emitted. Pele hands each render to the sanitiser and mounts the node
 * it returns, so this pass is what stands between a hostile diagram and the
 * page.
 */

/** A CSS `url(...)` that is not a same-document `url(#id)` reference. */
const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;

/**
 * MathML elements KaTeX emits, without `annotation` (the math resolver removes
 * it), `semantics` (only a wrapper, so its content is kept) and `mglyph` (an
 * image).
 */
export const KATEX_MATHML_TAGS: ReadonlySet<string> = new Set([
  "math", "menclose", "mfrac", "mi", "mlabeledtr", "mn", "mo", "mover", "mpadded", "mphantom",
  "mroot", "mrow", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd",
  "mtext", "mtr", "munder", "munderover"
]);

/** Presentation attributes KaTeX sets on those elements; the profiles already cover class, style, width, height, display and xmlns. */
export const KATEX_MATHML_ATTRIBUTES: ReadonlySet<string> = new Set([
  "accent", "accentunder", "columnalign", "columnlines", "columnspacing", "depth", "displaystyle",
  "fence", "largeop", "linebreak", "linethickness", "lspace", "mathbackground", "mathcolor",
  "mathsize", "mathvariant", "maxsize", "minsize", "notation", "rowlines", "rowspacing", "rspace",
  "scriptlevel", "separator", "stretchy", "voffset"
]);

const FORBID_ATTR = ["href", "xlink:href", "src", "srcset"];

type Purifier = ReturnType<typeof DOMPurify>;

export interface DiagramSanitizers {
  /** A diagram without math: SVG only; no `<foreignObject>`, no `<style>`. */
  plain(svg: string): Node;
  /**
   * A diagram with `$$` labels: pele puts each label's MathML in a
   * `<foreignObject>` with an HTML `<div>` around it, so that integration
   * point and KaTeX's MathML (and nothing else of HTML that can load or
   * navigate) are allowed. DOMPurify still accepts `<math>` only under an HTML
   * parent and checks every MathML child's namespace.
   */
  math(svg: string): Node;
}

/**
 * Builds both sanitisers, bound to one window. Remote `url(...)` in an inline
 * style becomes `none` (pele emits none, but a style the diagram itself sets
 * goes through here too); `<a>`, `<img>`, `<image>`, `<script>` and `<style>`
 * are dropped; `href`, `xlink:href`, `src` and `srcset` never survive. Label
 * text is untouched. Each returns a fragment for pele to mount.
 */
export function createDiagramSanitizers(win: Window & typeof globalThis): DiagramSanitizers {
  let purifier: Purifier | null = null;
  const get = (): Purifier => {
    if (!purifier) {
      const created = DOMPurify(win);
      created.addHook("uponSanitizeAttribute", (_node, data) => {
        if (data.attrName === "style") data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
      });
      purifier = created;
    }
    return purifier;
  };
  return {
    plain: (svg) =>
      get().sanitize(svg, {
        FORBID_ATTR,
        FORBID_TAGS: ["a", "image", "foreignObject", "style", "script"],
        USE_PROFILES: { svg: true, svgFilters: true },
        RETURN_DOM_FRAGMENT: true
      }),
    math: (svg) =>
      get().sanitize(svg, {
        ADD_TAGS: ["foreignObject", ...KATEX_MATHML_TAGS],
        ADD_ATTR: (attribute: string, tagName: string) =>
          KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
        HTML_INTEGRATION_POINTS: { foreignobject: true },
        FORBID_ATTR,
        FORBID_TAGS: ["a", "img", "image", "script", "style"],
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        RETURN_DOM_FRAGMENT: true
      })
  };
}

/** The colours and fonts pele reads from CSS, which a standalone image cannot inherit. */
export const PELE_VARIABLES = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  "--pele-error",
  "--pele-font",
  "--pele-font-mono",
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`)
] as const;

/** The DOM pieces `standaloneSvg` needs; a browser `window` satisfies it. */
export interface SvgDomEnvironment {
  getComputedStyle(element: Element): CSSStyleDeclaration;
  XMLSerializer: typeof XMLSerializer;
}

/**
 * A mounted diagram as a self-contained SVG document, for the expanded
 * viewer: an image cannot inherit the page's `--pele-*` variables, so their
 * resolved values (and the resolved font) are written onto the copy, with a
 * fixed size from the viewBox and an opaque background. The mounted SVG is
 * left alone.
 */
export function standaloneSvg(svg: SVGSVGElement, env: SvgDomEnvironment, background: string): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const computed = env.getComputedStyle(svg);
  for (const name of PELE_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value && value !== "inherit") element.style.setProperty(name, value);
  }
  const font = computed.getPropertyValue("font-family").trim();
  if (font) element.style.setProperty("--pele-font", font);
  const viewBox = element.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    element.setAttribute("width", String(viewBox[2]));
    element.setAttribute("height", String(viewBox[3]));
  }
  element.style.maxWidth = "none";
  element.style.backgroundColor = background;
  // Pele's math labels sit in an HTML `<div xmlns="…">`. Parsed as HTML, that
  // `xmlns` is a plain attribute, and the serialiser would write it next to
  // the declaration it adds itself: a duplicate attribute, a broken image.
  for (const node of Array.from(element.querySelectorAll("[xmlns]"))) node.removeAttribute("xmlns");
  // The serialiser supplies the SVG namespace declaration itself.
  return new env.XMLSerializer().serializeToString(element);
}

/**
 * A `blob:` URL for the standalone SVG. Not a `data:` URL: the desktop
 * connect-src policy refuses those for the media viewer's save and copy
 * fetches, and the production `img-src` allows `blob:`. The caller owns the
 * URL and must `URL.revokeObjectURL` it.
 */
export function createDiagramBlobUrl(svg: SVGSVGElement): string {
  const view = svg.ownerDocument.defaultView ?? window;
  const background = view.getComputedStyle(svg.ownerDocument.body).backgroundColor;
  const markup = standaloneSvg(svg, { getComputedStyle: (element) => view.getComputedStyle(element), XMLSerializer: view.XMLSerializer }, background);
  return URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
}
