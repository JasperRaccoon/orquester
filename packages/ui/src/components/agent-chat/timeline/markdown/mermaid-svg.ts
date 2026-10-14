// Ported from T3 Code (MIT): apps/web/src/components/chat/MermaidDiagram.tsx
// (the DOMPurify pass and the standalone-SVG blob), hardened further here.

import DOMPurify from "dompurify";

/**
 * What happens to Mermaid's SVG between the engine and the page (spec §4).
 *
 * Diagram source is untrusted model output. Mermaid's own
 * `securityLevel: "strict"` is the first line; this is the second: strip
 * anything that can navigate, run script or fetch remote content, whatever
 * Mermaid emitted. The SVG is then mounted as markup, so this pass is what
 * stands between a hostile diagram and the page.
 */

/** A CSS `url(...)` that is not a same-document `url(#id)` reference. */
const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;

type Purifier = ReturnType<typeof DOMPurify>;

/**
 * Builds a sanitiser bound to one window. Remote `url(...)` in CSS is replaced
 * with `none`, keeping only local `url(#id)` references (markers, gradients);
 * `<a>`, `<img>`, `<image>` and `<script>` are dropped; `href`, `xlink:href`,
 * `src` and `srcset` never survive (DOMPurify drops `<use>` itself, so no
 * Mermaid output needs a reference attribute). Label text is untouched.
 */
export function createMermaidSvgSanitizer(win: Window & typeof globalThis): (svg: string) => string {
  let purifier: Purifier | null = null;
  return (svg) => {
    if (!purifier) {
      const created = DOMPurify(win);
      created.addHook("uponSanitizeElement", (node, data) => {
        if (data.tagName === "style" && node.textContent) {
          node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
        }
      });
      created.addHook("uponSanitizeAttribute", (_node, data) => {
        if (data.attrName === "style") {
          data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
        }
      });
      purifier = created;
    }
    return purifier.sanitize(svg, {
      ADD_TAGS: ["foreignObject"],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
      FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
      FORBID_TAGS: ["a", "img", "image", "script"],
      USE_PROFILES: { svg: true, svgFilters: true, html: true }
    });
  };
}

/** The DOM constructors `standaloneSvg` needs; a browser `window` satisfies it. */
export interface SvgDomEnvironment {
  DOMParser: typeof DOMParser;
  XMLSerializer: typeof XMLSerializer;
}

/**
 * A rendered diagram as a self-contained SVG document with a fixed size and an
 * opaque background, for the expanded viewer. Mermaid's inline SVG is
 * `width="100%"` with a `max-width` style, which collapses outside its host.
 *
 * `svg` is DOMPurify's output, which is **HTML** markup (U+00A0 comes out as
 * `&nbsp;`, an entity XML does not define), so it is parsed as HTML and the
 * element re-serialised as XML. Parsing it as XML would turn any non-breaking
 * space in a label into a parser error and a broken image. Throws when there
 * is no SVG to serialise.
 */
export function standaloneSvg(svg: string, env: SvgDomEnvironment, background: string): string {
  const element = new env.DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  if (!element) throw new Error("The diagram could not be prepared for viewing.");
  const viewBox = element.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    element.setAttribute("width", String(viewBox[2]));
    element.setAttribute("height", String(viewBox[3]));
  }
  element.setAttribute("style", `max-width:none;background-color:${background}`);
  // The serialiser supplies the SVG namespace declaration itself.
  return new env.XMLSerializer().serializeToString(element);
}

/**
 * A `blob:` URL for the standalone SVG. Not a `data:` URL: the desktop
 * connect-src policy refuses those for the media viewer's save and copy
 * fetches, and the production `img-src` allows `blob:`. The caller owns the
 * URL and must `URL.revokeObjectURL` it.
 */
export function createDiagramBlobUrl(svg: string): string {
  const background = getComputedStyle(document.body).backgroundColor;
  const markup = standaloneSvg(svg, { DOMParser, XMLSerializer }, background);
  return URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
}
