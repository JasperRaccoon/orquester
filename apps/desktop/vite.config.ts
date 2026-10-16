import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vite";
import { excalidrawAssets } from "../../packages/ui/vite/excalidraw-assets";

export default defineConfig({
  base: "./",
  // noVNC 1.7 (desktop tabs) keeps a top-level `await` in core/util/browser.js,
  // which needs an es2022 target in both the build and the dev pre-bundle.
  build: {
    target: "es2022",
    // KaTeX's fonts stay separate files: Vite inlines assets under 4 KB as
    // `data:` URIs, and the production CSP (no font-src, so default-src
    // 'self') refuses a data: font.
    assetsInlineLimit: (file) => (/KaTeX_[^/]*\.(woff2?|ttf)$/.test(file) ? false : undefined)
  },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  plugins: [
    react(),
    // The whiteboard plugin's fonts, served from the app (see the plugin).
    excalidrawAssets(),
    svgr({
      svgrOptions: {
        icon: true,
        svgProps: { width: "1em", height: "1em" }
      }
    })
  ]
});
