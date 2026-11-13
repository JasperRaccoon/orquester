/**
 * The embeddable agent chat (docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md
 * §5.1–§5.3, §5.6–§5.9): `src/embed/index.ts` as a self-contained ES module
 * under `dist/embed/`, served at `/embed/*` and loaded cross-origin by other
 * apps. Runs after the SPA build (`build` script), which empties `dist/`.
 *
 * - React 18 is bundled: the host page may run another React.
 * - `base: "./"`: lazy chunks and fonts resolve against the entry's own URL
 *   (`import.meta.url`), on whatever origin served it.
 * - All CSS goes into the shadow root (src/embed/styles.ts); none is emitted.
 * - A lazy chunk that fails to load (a redeploy removed it) fires
 *   `EMBED_PRELOAD_ERROR_EVENT` on `window` (the preload helper wraps every
 *   `import()`), renamed from Vite's `vite:preloadError`, which the host
 *   page's own Vite build may listen to (`embedPreloadErrorEvent`).
 *
 * `ORQUESTER_EMBED_GUARD=report` lists forbidden app modules instead of failing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vite";
import { orquesterBuildDefine } from "../../packages/ui/vite/build-id";
import { orquesterPreset } from "../../packages/ui/tailwind-preset";
import { EMBED_CONTRACT, EMBED_ELEMENT, EMBED_PRELOAD_ERROR_EVENT, EMBED_ROOT_CLASS } from "./src/embed/contract";
import { embedCssImports, embedFiles, embedGuard, embedPreloadErrorEvent } from "./vite/embed-bundle";
import { bodyFontStack, embedCssVariables, embedShadowCss } from "./vite/embed-css";

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const REPO_ROOT = path("../../");
const UI_ROOT = path("../../packages/ui/");
const GLOBALS_CSS = readFileSync(path("../../packages/ui/src/styles/globals.css"), "utf8");

/** What Tailwind scans for the embed's classes: the chat's components and the embed itself. */
const TAILWIND_CONTENT = [
  path("../../packages/ui/src/components/agent-chat/"),
  path("../../packages/ui/src/components/ui/"),
  path("../../packages/ui/src/lib/"),
  path("../../packages/ui/src/icons/"),
  path("../../packages/ui/src/components/git/"),
  path("./src/embed/")
];

const define = orquesterBuildDefine();
const BUILD = JSON.parse(define.__ORQUESTER_BUILD__) as string;

export default defineConfig({
  base: "./",
  publicDir: false,
  define,
  resolve: {
    // The workflow editor's canvas CSS, imported by globals.css, stays out of the chat.
    alias: [{ find: /^\.\/workflows\.css$/, replacement: path("./src/embed/omitted.css") }]
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          presets: [orquesterPreset],
          content: TAILWIND_CONTENT.map((dir) => `${dir}**/*.{ts,tsx}`),
          theme: {
            extend: {
              fontFamily: {
                sans: [`var(--orq-font-sans, ${bodyFontStack(GLOBALS_CSS)})`],
                mono: [`var(--orq-font-mono, ${defaultTheme.fontFamily.mono.join(", ")})`]
              }
            }
          }
        }),
        embedShadowCss({ rootClass: EMBED_ROOT_CLASS }),
        autoprefixer()
      ]
    }
  },
  build: {
    outDir: "dist/embed",
    emptyOutDir: false,
    target: "es2022",
    // The host page's <head> is not ours: no modulepreload links in it.
    modulePreload: false,
    copyPublicDir: false,
    // Fonts stay files: a `data:` font would need the host page's CSP to allow it.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/.test(file) ? false : undefined),
    rollupOptions: {
      input: { "agent-chat": path("./src/embed/index.ts") },
      // Keep the entry's exports (`define`, `contract`), which Vite's app builds drop; code shared
      // with lazy chunks may add more, so it stays in the entry instead of a chunk of its own.
      preserveEntrySignatures: "allow-extension",
      output: {
        format: "es",
        entryFileNames: "agent-chat.[hash].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: (asset) =>
          /\.(woff2?|ttf|otf|eot)$/.test(asset.names[0] ?? "") ? "fonts/[name].[hash][extname]" : "assets/[name].[hash][extname]"
      }
    }
  },
  plugins: [
    react(),
    svgr({ svgrOptions: { icon: true, svgProps: { width: "1em", height: "1em" } } }),
    embedCssImports({ stylesModule: path("./src/embed/styles.ts"), baseStylesDir: path("../../packages/ui/src/styles/") }),
    embedGuard({
      uiRoot: UI_ROOT,
      mode: process.env.ORQUESTER_EMBED_GUARD === "report" ? "report" : "fail",
      tailwindContent: TAILWIND_CONTENT
    }),
    embedPreloadErrorEvent({ eventName: EMBED_PRELOAD_ERROR_EVENT }),
    embedFiles({
      repoRoot: REPO_ROOT,
      contract: EMBED_CONTRACT,
      element: EMBED_ELEMENT,
      build: BUILD,
      variables: embedCssVariables(GLOBALS_CSS),
      banner: "/*! Orquester agent-chat embed — MIT — see LICENSES.txt */"
    })
  ]
});
