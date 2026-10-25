import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig, type Rollup } from "vite";
import { excalidrawAssets } from "../../packages/ui/vite/excalidraw-assets";
import { orquesterBuildDefine } from "../../packages/ui/vite/build-id";

/**
 * Vendor chunks: the third-party code the first paint needs, out of the entry
 * chunk, so a deploy that changes only app code leaves them cached (the
 * service worker keeps `/assets/` cache-first) and a phone re-downloads the
 * app's own code alone.
 *
 * - `react`: React, React DOM and the scheduler.
 * - `vendor`: the packages below the app's first paint (the chat's markdown,
 *   the persisted-data schemas…), named by the package the app imports, with
 *   every module only those packages lead to. A package only lazy features
 *   use must not be listed: it would load with the app. Nor may one that
 *   imports such a package, even from code tree-shaking drops — a manual chunk
 *   takes in every module its modules import: remark-math stays out, as its
 *   unused HTML extension imports KaTeX.
 */
const REACT_PACKAGES = new Set(["react", "react-dom", "scheduler"]);
const EAGER_VENDOR_ROOTS = new Set([
  "react-markdown",
  "remark-gfm",
  "zod",
  "zustand",
  "dompurify",
  "tailwind-merge",
  "clsx",
  "fuzzysort",
  "@lezer/common",
  "@lezer/highlight"
]);

/** The npm package a module id belongs to, or null for app code. */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const [scope, name] = id.slice(at + "/node_modules/".length).split("/");
  return scope.startsWith("@") ? `${scope}/${name}` : scope;
}

type ModuleInfoOf = (id: string) => Rollup.ModuleInfo | null;

/**
 * The packages the app imports to reach `id` (an npm module): walking its
 * importers up, the first npm module on each path that app code imports.
 */
function rootPackages(id: string, info: ModuleInfoOf, memo: Map<string, Set<string>>): Set<string> {
  const known = memo.get(id);
  if (known) return known;
  const roots = new Set<string>();
  memo.set(id, roots); // a cycle contributes nothing more
  const module = info(id);
  for (const importer of [...(module?.importers ?? []), ...(module?.dynamicImporters ?? [])]) {
    if (packageOf(importer) === null) roots.add(packageOf(id)!);
    else for (const root of rootPackages(importer, info, memo)) roots.add(root);
  }
  return roots;
}

function vendorChunks(): Rollup.GetManualChunk {
  const memo = new Map<string, Set<string>>();
  return (id, { getModuleInfo }) => {
    const pkg = packageOf(id);
    if (pkg === null) return undefined;
    if (REACT_PACKAGES.has(pkg)) return "react";
    if (EAGER_VENDOR_ROOTS.has(pkg)) return "vendor";
    const roots = rootPackages(id, getModuleInfo, memo);
    if (roots.size > 0 && [...roots].every((root) => EAGER_VENDOR_ROOTS.has(root))) return "vendor";
    return undefined;
  };
}

export default defineConfig({
  // noVNC 1.7 (desktop tabs) keeps a top-level `await` in core/util/browser.js,
  // which needs an es2022 target in both the build and the dev pre-bundle.
  build: {
    target: "es2022",
    // KaTeX's fonts stay separate files: Vite inlines assets under 4 KB as
    // `data:` URIs, and the production CSP (no font-src, so default-src
    // 'self') refuses a data: font.
    assetsInlineLimit: (file) => (/KaTeX_[^/]*\.(woff2?|ttf)$/.test(file) ? false : undefined),
    rollupOptions: { output: { manualChunks: vendorChunks() } }
  },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  // The app build named in the connection diagnostics.
  define: orquesterBuildDefine(),
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
