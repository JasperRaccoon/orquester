/**
 * KaTeX and its stylesheet, as one lazily loaded chunk. Only `math-typeset.ts`
 * imports this file, and only through `import()`, so the bundler splits KaTeX,
 * its CSS and its fonts out of the main bundle: a session that never shows a
 * formula never downloads them. The fonts stay separate files (never `data:`
 * URIs, which the production CSP refuses): see `assetsInlineLimit` in the web
 * and desktop `vite.config.ts`.
 */
import katex from "katex";
import "katex/dist/katex.min.css";

export default katex;
