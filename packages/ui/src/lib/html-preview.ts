/**
 * Prepare an HTML file's text for the static-preview iframe.
 *
 * The preview renders the HTML from a `blob:` URL (see HtmlViewer), which gives
 * the document a real URL: `#fragment` links scroll in place, and relative links
 * resolve within the `blob:` scheme — never to the app's own `https://` origin
 * (which `frame-ancestors 'none'` would block). The one remaining wart is a TOC
 * link written with the current file's own name (`href="dossier.html#sec"`):
 * that resolves to a *different* blob path and fails to load, so we rewrite such
 * self-referential links to bare fragments (`href="#sec"`).
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn `href="<filename>#x"` / `href='./<filename>#x'` (a self-link to the file
 *  being previewed) into a bare fragment `href="#x"` so it scrolls in place. */
export function rewriteSelfAnchors(html: string, filename: string): string {
  if (!filename) return html;
  const esc = escapeRegExp(filename);
  return html.replace(new RegExp(`(href\\s*=\\s*["'])(?:\\./)?${esc}(#)`, "gi"), "$1$2");
}
