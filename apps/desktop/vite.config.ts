import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // noVNC 1.7 (desktop tabs) keeps a top-level `await` in core/util/browser.js,
  // which needs an es2022 target in both the build and the dev pre-bundle.
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        icon: true,
        svgProps: { width: "1em", height: "1em" }
      }
    })
  ]
});
