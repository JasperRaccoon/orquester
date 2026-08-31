/**
 * Render a Markdown file's text into a complete, self-contained HTML document
 * for the static-preview iframe (see MarkdownViewer — same empty-sandbox model
 * as HtmlViewer: static markup + CSS only, zero JS execution, so any raw HTML
 * embedded in the markdown is inert by construction).
 *
 * Headings get GitHub-style `id` slugs so TOC links (`[x](#section)`) scroll in
 * place — the blob: URL gives the document a real URL for `#fragment` links,
 * and marked itself stopped emitting heading ids in v5.
 */

import { Marked } from "marked";

/** GitHub-flavoured slug: lowercase, drop punctuation, each space -> a hyphen
 *  (deliberately NOT collapsed — GitHub keeps one hyphen per removed char run,
 *  so hand-copied GitHub TOC links resolve here too). */
function slugify(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Markdown -> body HTML with GFM + deduped GitHub-style heading ids. */
export function renderMarkdownBody(markdown: string): string {
  // A fresh instance per call: the slug dedupe counter is per-document state,
  // and a shared Marked singleton would leak it across renders.
  const seen = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const base = slugify(html) || "section";
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        return `<h${depth} id="${escapeHtml(id)}">${html}</h${depth}>\n`;
      }
    }
  });
  return marked.parse(markdown, { async: false });
}

/** Minimal GitHub-like document styles, one palette per resolved mode. */
function docCss(mode: "light" | "dark"): string {
  const dark = mode === "dark";
  const fg = dark ? "#d4d4d8" : "#1f2328";
  const bg = dark ? "#18181b" : "#ffffff";
  const muted = dark ? "#a1a1aa" : "#59636e";
  const border = dark ? "#3f3f46" : "#d1d9e0";
  const codeBg = dark ? "#27272a" : "#f6f8fa";
  const link = dark ? "#7dd3fc" : "#0969da";
  return `
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  body { margin: 0; padding: 24px 32px 48px; background: ${bg}; color: ${fg};
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 860px; box-sizing: border-box; word-wrap: break-word; }
  h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 0.6em; line-height: 1.25; font-weight: 600; }
  h1:first-child { margin-top: 0; }
  h1 { font-size: 1.9em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.05em; }
  h5, h6 { font-size: 0.95em; }
  h6 { color: ${muted}; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
  a { color: ${link}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em;
    background: ${codeBg}; border-radius: 4px; padding: 0.15em 0.35em; }
  pre { background: ${codeBg}; border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 0.85em; }
  blockquote { border-left: 3px solid ${border}; padding: 0 1em; color: ${muted}; }
  ul, ol { padding-left: 1.8em; }
  li + li { margin-top: 0.2em; }
  li > input[type="checkbox"] { margin: 0 0.4em 0.1em -1.4em; vertical-align: middle; }
  hr { border: 0; border-top: 1px solid ${border}; margin: 1.5em 0; }
  table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
  th, td { border: 1px solid ${border}; padding: 5px 12px; }
  th { font-weight: 600; background: ${codeBg}; }
  img { max-width: 100%; }
  `;
}

/** Full HTML document (markup + themed CSS) ready for a blob: iframe. */
export function renderMarkdownDocument(markdown: string, title: string, mode: "light" | "dark"): string {
  const body = renderMarkdownBody(markdown);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${docCss(mode)}</style></head><body>${body}</body></html>`;
}
