/**
 * Prepare an HTML file's text for the static-preview iframe so in-page anchor
 * links work and the preview never navigates to the app's own origin.
 *
 * Why: a sandboxed `srcdoc` document's base URL is the PARENT (app) URL, so a
 * link like `href="dossier.html#sec"` or even a bare `href="#sec"` resolves to
 * `https://app/…#sec` and the iframe tries to load the app into itself — which
 * `frame-ancestors 'none'` blocks. Two transforms fix that:
 *
 *  1. Rewrite self-referential links (`href="<thisfile>#sec"`) to bare fragments
 *     (`href="#sec"`).
 *  2. Inject `<base href="about:srcdoc">` so fragments resolve against the
 *     srcdoc document itself → an in-page scroll, not a navigation to the app.
 *
 * Cross-file links (to a *different* file) resolve to an unloadable URL and fail
 * silently — the isolated, script-free preview can't serve other project files.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn `href="<filename>#x"` / `href='./<filename>#x'` into `href="#x"`. */
export function rewriteSelfAnchors(html: string, filename: string): string {
  if (!filename) return html;
  const esc = escapeRegExp(filename);
  return html.replace(new RegExp(`(href\\s*=\\s*["'])(?:\\./)?${esc}(#)`, "gi"), "$1$2");
}

const BASE_TAG = '<base href="about:srcdoc">';

/** Inject the neutral <base> as early as possible without disturbing the doctype. */
export function injectBase(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + BASE_TAG);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${BASE_TAG}</head>`);
  return `${BASE_TAG}${html}`;
}

/** Full transform applied before handing the HTML to the preview iframe. */
export function buildHtmlSrcdoc(html: string, filename: string): string {
  return injectBase(rewriteSelfAnchors(html, filename));
}
