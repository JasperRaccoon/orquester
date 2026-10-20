/**
 * An agent-written HTML fragment, shown inert in a frame wearing the app's
 * theme — a question option's HTML `preview`.
 *
 * Not {@link VisualDocument}: that frame runs a page the daemon serves, with
 * scripts, from a URL minted for it. A fragment has no URL and needs no
 * scripts (Claude is told to write no `<script>` and no `<style>`), so it
 * takes the file viewers' static-preview model instead (`HtmlViewer`): an
 * **empty `sandbox`** — no scripts, forms, popups or same-origin access — over
 * a `blob:` URL, never `srcdoc` and never the app's own DOM. The document's
 * own CSP refuses every fetch but inline styles and `data:` images, so a
 * fragment cannot even beacon out by loading an image.
 */

import React from "react";

import { sanitizeHtmlRenderThemeVariables, type HtmlRenderTheme } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { useVisualTheme } from "./use-visual-theme";

const SNIPPET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * The whole document a fragment is framed in: the theme's tokens on `:root`
 * (sanitised exactly as a page's bootstrap would, so no value can close the
 * `<style>`), the app's base type, then the fragment as the body.
 */
export function visualSnippetDocument(html: string, theme: HtmlRenderTheme): string {
  const variables = Object.entries(sanitizeHtmlRenderThemeVariables(theme.variables))
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const css =
    `:root{color-scheme:${theme.appearance};${variables}}` +
    "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);" +
    "font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}" +
    "body{margin:0;padding:10px 12px;overflow-wrap:anywhere}" +
    "code,kbd,pre,samp{font-family:var(--font-mono,monospace)}img,svg{max-width:100%}";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SNIPPET_CSP}">` +
    `<style>${css}</style></head><body>${html}</body></html>`
  );
}

export function VisualSnippet(props: { html: string; title: string; className?: string }): React.ReactElement {
  const theme = useVisualTheme();
  const page = React.useMemo(() => visualSnippetDocument(props.html, theme), [props.html, theme]);
  // A new blob per document: a theme change re-renders the fragment, which
  // has no script to restyle itself.
  const [src, setSrc] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [page]);

  // Until the first blob exists the box holds the frame's place, so the pane
  // does not jump when it lands.
  if (src === null) return <div aria-hidden className={cn("block", props.className)} />;
  return (
    <iframe
      // Empty sandbox: static markup and CSS only, an opaque origin, no script.
      sandbox=""
      src={src}
      title={props.title}
      referrerPolicy="no-referrer"
      data-visual-snippet=""
      onLoad={() => setLoaded(true)}
      className={cn("block border-0 bg-transparent", props.className)}
      // A frame whose colour scheme differs from its document's paints an
      // opaque canvas: `light` (the blank document's) until the fragment's
      // document, whose `color-scheme` is the theme's, is in (`VisualDocument`).
      style={{ colorScheme: loaded ? theme.appearance : "light" }}
    />
  );
}
