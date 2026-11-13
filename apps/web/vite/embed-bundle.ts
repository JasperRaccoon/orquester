// Rollup/Vite plugins of the embed build (vite.embed.config.ts): CSS imports
// turned into shadow-root sheets, the build guard (design §5.6), and the files
// written beside the bundle — manifest.json, LICENSES.txt, variables.json.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin, Rollup } from "vite";

/** A module id as a plain `/`-separated path: no `\0` marker, no `?query`. */
function modulePath(id: string): string {
  return id.replace(/^\0/, "").replace(/[?#].*$/, "").split(sep).join("/");
}

// ---------------------------------------------------------------------------
// The build guard
// ---------------------------------------------------------------------------

/**
 * `packages/ui` modules that must never end up in the embed: they pull in the
 * whole app (its store, API client, thread store, composer). A path ending in
 * `/` is a directory; any other is a module (any extension) or a directory.
 */
export const EMBED_FORBIDDEN_UI_MODULES = [
  "src/store/app",
  "src/context/orquester-context",
  "src/lib/agent-chat/store",
  "src/lib/session-profiles/store",
  "src/lib/agent-tools/store",
  "src/components/agent-chat/composer/"
] as const;

/**
 * The forbidden modules among `moduleIds` (Rollup ids), as paths relative to
 * `uiRoot` (the `packages/ui` directory), sorted and unique.
 */
export function forbiddenEmbedModules(moduleIds: Iterable<string>, uiRoot: string): string[] {
  const root = modulePath(uiRoot).replace(/\/$/, "");
  const found = new Set<string>();
  for (const id of moduleIds) {
    const path = modulePath(id);
    if (!path.startsWith(`${root}/`)) continue;
    const rel = path.slice(root.length + 1);
    const forbidden = EMBED_FORBIDDEN_UI_MODULES.some((entry) =>
      entry.endsWith("/")
        ? rel.startsWith(entry)
        : rel === entry || rel.startsWith(`${entry}.`) || rel.startsWith(`${entry}/`)
    );
    if (forbidden) found.add(rel);
  }
  return [...found].sort();
}

/** Every module that contributes code to `bundle`: Rollup's rendered module list, after tree-shaking. */
function renderedModules(bundle: Rollup.OutputBundle): string[] {
  const ids = new Set<string>();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const [id, module] of Object.entries(output.modules)) {
      if (module.renderedLength > 0) ids.add(id);
    }
  }
  return [...ids];
}

export interface EmbedGuardOptions {
  /** The `packages/ui` directory. */
  uiRoot: string;
  /** `report` lists the forbidden modules and lets the build pass. */
  mode: "fail" | "report";
  /** Directories Tailwind scans for the embed's classes (absolute). */
  tailwindContent: readonly string[];
}

/**
 * Fails the build when the emitted bundle holds a forbidden `packages/ui`
 * module (design §5.6) or a CSS file (which Vite would inject into the host
 * page's `<head>`). Warns about rendered `packages/ui` components Tailwind does
 * not scan, whose classes would be missing from the shadow root's CSS.
 */
export function embedGuard(options: EmbedGuardOptions): Plugin {
  return {
    name: "orquester-embed-guard",
    apply: "build",
    generateBundle(_output, bundle) {
      const modules = renderedModules(bundle);

      const cssFiles = Object.keys(bundle).filter((file) => file.endsWith(".css"));
      if (cssFiles.length > 0) {
        this.error(
          `the embed bundle emits CSS files (${cssFiles.join(", ")}), which would load into the host page; ` +
            "import CSS from the embed path only as a side-effect import, so embedCssImports adopts it into the shadow root"
        );
      }

      const content = options.tailwindContent.map((dir) => `${modulePath(dir).replace(/\/$/, "")}/`);
      const uiRoot = `${modulePath(options.uiRoot).replace(/\/$/, "")}/`;
      const unscanned = modules
        .map(modulePath)
        .filter((path) => path.startsWith(uiRoot) && path.endsWith(".tsx") && !content.some((dir) => path.startsWith(dir)))
        .map((path) => path.slice(uiRoot.length))
        .sort();
      if (unscanned.length > 0) {
        this.warn(
          `${unscanned.length} rendered packages/ui component(s) are outside the embed's Tailwind content; ` +
            `their classes may be missing in the shadow root:\n  ${unscanned.join("\n  ")}`
        );
      }

      const forbidden = forbiddenEmbedModules(modules, options.uiRoot);
      if (forbidden.length === 0) return;
      const list = `\n  ${forbidden.join("\n  ")}`;
      if (options.mode === "report") {
        this.warn(`embed guard (report only): ${forbidden.length} forbidden packages/ui module(s) in the bundle:${list}`);
        return;
      }
      this.error(
        `embed guard: ${forbidden.length} packages/ui module(s) that pull in the whole app are in the bundle ` +
          `(design §5.6; ORQUESTER_EMBED_GUARD=report lists them without failing):${list}`
      );
    }
  };
}

// ---------------------------------------------------------------------------
// CSS imports → shadow-root sheets
// ---------------------------------------------------------------------------

const CSS_SIDE_EFFECT_IMPORT = /^[ \t]*import\s+(["'])([^"'\n]+\.css)\1[ \t]*;?/gm;

export interface EmbedCssImportsOptions {
  /** `apps/web/src/embed/styles.ts`: exports `adoptLazyStyles(css)`. */
  stylesModule: string;
  /** Stylesheets already compiled into the embed's base sheet (`packages/ui/src/styles`): their imports are dropped. */
  baseStylesDir: string;
}

/**
 * Rewrites every side-effect CSS import in the embed's own code
 * (`import "katex/dist/katex.min.css"`) into a string import registered with
 * `styles.ts`, which adopts it into every embed shadow root instead of letting
 * Vite inject it into the host page's `<head>`. Imports of the base sheet's own
 * files (`globals.css`) are dropped: the base sheet already holds them.
 */
export function embedCssImports(options: EmbedCssImportsOptions): Plugin {
  const stylesModule = modulePath(options.stylesModule);
  const baseStylesDir = `${modulePath(options.baseStylesDir).replace(/\/$/, "")}/`;
  return {
    name: "orquester-embed-css-imports",
    apply: "build",
    enforce: "pre",
    async transform(code, id) {
      const path = modulePath(id);
      if (path.includes("/node_modules/") || !/\.[cm]?[jt]sx?$/.test(path) || path === stylesModule) return null;
      const imports = [...code.matchAll(CSS_SIDE_EFFECT_IMPORT)];
      if (imports.length === 0) return null;
      let out = "";
      let last = 0;
      let adopt = false;
      for (const [index, match] of imports.entries()) {
        const specifier = match[2];
        const resolved = await this.resolve(specifier, id);
        if (!resolved) this.error(`cannot resolve ${specifier} from ${id}`);
        out += code.slice(last, match.index);
        last = match.index + match[0].length;
        if (modulePath(resolved.id).startsWith(baseStylesDir)) continue;
        const name = `__orquesterEmbedCss${index}`;
        out += `import ${name} from ${JSON.stringify(`${specifier}?inline`)}; __orquesterAdoptLazyStyles(${name});`;
        adopt = true;
      }
      out += code.slice(last);
      if (adopt) {
        out = `import { adoptLazyStyles as __orquesterAdoptLazyStyles } from ${JSON.stringify(stylesModule)};\n${out}`;
      }
      return { code: out, map: null };
    }
  };
}

// ---------------------------------------------------------------------------
// manifest.json, LICENSES.txt, variables.json
// ---------------------------------------------------------------------------

/** The directory of the npm package a module id belongs to, or null for repository code. */
export function packageDirOf(id: string): string | null {
  const path = modulePath(id);
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const segments = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length <= segments) return null;
  return `${path.slice(0, at)}/node_modules/${rest.slice(0, segments).join("/")}`;
}

interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

function readPackage(dir: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    license?: string | { type?: string };
  };
  const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? "UNKNOWN";
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort();
  const text = files.map((file) => readFileSync(join(dir, file), "utf8").trim()).join("\n\n");
  return {
    name: manifest.name ?? relative(dirname(dir), dir),
    version: manifest.version ?? "0.0.0",
    license,
    text: text || `(The package ships no licence file; its package.json declares "${license}".)`
  };
}

/** Vite's own licence, without the bundled-dependency appendix (the preload helper is Vite's code). */
function viteLicense(): BundledPackage {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve("vite/package.json"));
  const pkg = readPackage(dir);
  const file = readdirSync(dir).find((name) => LICENSE_FILE.test(name));
  const full = file ? readFileSync(join(dir, file), "utf8") : pkg.text;
  const cut = full.indexOf("# Licenses of bundled dependencies");
  return { ...pkg, text: (cut > 0 ? full.slice(0, cut) : full).trim() };
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

function licensesText(repoRoot: string, moduleIds: Iterable<string>): string {
  const dirs = new Set<string>();
  let viteHelpers = false;
  for (const id of moduleIds) {
    if (id.startsWith("\0vite/")) viteHelpers = true;
    const dir = packageDirOf(id);
    if (dir) dirs.add(dir);
  }
  const packages = [...dirs].map(readPackage);
  if (viteHelpers && !packages.some((pkg) => pkg.name === "vite")) packages.push(viteLicense());
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = [
    "Orquester agent-chat embed: licences",
    `${RULE}\nOrquester (LICENSE)\n${RULE}\n\n${readFileSync(join(repoRoot, "LICENSE"), "utf8").trim()}`,
    `${RULE}\nThird-party notices (docs/THIRD_PARTY_NOTICES.md)\n${RULE}\n\n${readFileSync(join(repoRoot, "docs/THIRD_PARTY_NOTICES.md"), "utf8").trim()}`,
    `${RULE}\nnpm packages in this bundle (${packages.length})\n${RULE}`,
    ...packages.map((pkg) => `${THIN}\n${pkg.name}@${pkg.version} (${pkg.license})\n${THIN}\n\n${pkg.text}`)
  ];
  return `${sections.join("\n\n")}\n`;
}

export interface EmbedFilesOptions {
  repoRoot: string;
  contract: number;
  element: string;
  /** The short commit (`__ORQUESTER_BUILD__`). */
  build: string;
  /** The `--orq-*` variables (`embedCssVariables`). */
  variables: readonly string[];
  /** A `/*! … *\/` comment the entry chunk starts with, after minification. */
  banner: string;
}

const EMBED_LICENSES_FILE = "LICENSES.txt";

/**
 * Starts the entry chunk with the licence banner, and writes manifest.json,
 * LICENSES.txt and variables.json beside the bundle.
 */
export function embedFiles(options: EmbedFilesOptions): Plugin {
  return {
    name: "orquester-embed-files",
    apply: "build",
    generateBundle(_output, bundle) {
      const entries = Object.values(bundle).filter(
        (output): output is Rollup.OutputChunk => output.type === "chunk" && output.isEntry
      );
      if (entries.length !== 1) this.error(`the embed build must have one entry chunk, found ${entries.length}`);
      // Here rather than `output.banner`, so it is the first line whatever the minifier does with comments.
      entries[0].code = `${options.banner}\n${entries[0].code}`;
      const manifest = {
        contract: options.contract,
        build: options.build,
        entry: entries[0].fileName,
        element: options.element,
        licenses: EMBED_LICENSES_FILE
      };
      this.emitFile({ type: "asset", fileName: "manifest.json", source: `${JSON.stringify(manifest, null, 2)}\n` });
      this.emitFile({
        type: "asset",
        fileName: "variables.json",
        source: `${JSON.stringify({ contract: options.contract, variables: options.variables }, null, 2)}\n`
      });
      this.emitFile({
        type: "asset",
        fileName: EMBED_LICENSES_FILE,
        source: licensesText(options.repoRoot, renderedModules(bundle))
      });
    }
  };
}

/** Vite's preload helper, which every lazy `import()` of the bundle goes through. */
const PRELOAD_HELPER_ID = "\0vite/preload-helper.js";
/** The event that helper dispatches on `window` when a chunk fails to load. */
const VITE_PRELOAD_ERROR = /(["'`])vite:preloadError\1/g;

export interface EmbedPreloadErrorEventOptions {
  /** The embed's own event name (`EMBED_PRELOAD_ERROR_EVENT`). */
  eventName: string;
}

/**
 * Renames the event the embed's preload helper dispatches on `window` from
 * Vite's `vite:preloadError` to the embed's own. Vite's name is shared with
 * the host page: a host built with Vite that reloads on `vite:preloadError`
 * (Vite's documented pattern) would reload when an embed chunk failed, and the
 * element would take a host chunk's failure for its own. A chunk holding the
 * helper without that name fails the build, so a Vite upgrade that changes
 * the helper cannot silently undo the rename.
 */
export function embedPreloadErrorEvent(options: EmbedPreloadErrorEventOptions): Plugin {
  const renamed = JSON.stringify(options.eventName);
  return {
    name: "orquester-embed-preload-error-event",
    apply: "build",
    renderChunk(code, chunk) {
      const rewritten = code.replace(VITE_PRELOAD_ERROR, renamed);
      if (rewritten !== code) return { code: rewritten, map: null };
      if (chunk.moduleIds.includes(PRELOAD_HELPER_ID)) {
        this.error(
          `Vite's preload helper in ${chunk.fileName} no longer dispatches "vite:preloadError": update the embed's rename`
        );
      }
      return null;
    }
  };
}
