/// <reference types="node" />
// Vite plugin shared by the web and desktop builds: serves Excalidraw's fonts
// (the whiteboard plugin) from the app itself, at `<base>/excalidraw/fonts/…`,
// where `ExcalidrawBoard` points `window.EXCALIDRAW_ASSET_PATH`. Excalidraw
// would otherwise fetch them from esm.sh, which the app's CSP blocks and an
// offline host cannot reach. The fonts keep their own paths (Excalidraw asks
// for them by name), so they are copied as they are, not bundled as hashed
// assets, and stay out of the service worker's capped `/assets/` cache.

import { cp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";

/** Keep in step with `EXCALIDRAW_ASSETS_DIR` in `src/lib/whiteboard.ts`. */
const ASSETS_DIR = "excalidraw";

/** `dist/prod/fonts` of the installed @excalidraw/excalidraw (its "default" export is `dist/prod/index.js`). */
function excalidrawFontsDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
}

// The slice of Vite's plugin API used here, typed structurally: this package
// has no Vite of its own, and the apps' Vite types must not meet a second copy.
interface ResolvedConfigSlice {
  root: string;
  base: string;
  build: { outDir: string };
}

interface DevServerSlice {
  config: { base: string };
  middlewares: { use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void };
}

interface ExcalidrawAssetsPlugin {
  name: string;
  configResolved(config: ResolvedConfigSlice): void;
  configureServer(server: DevServerSlice): void;
  writeBundle(): Promise<void>;
}

export function excalidrawAssets(): ExcalidrawAssetsPlugin {
  let config: ResolvedConfigSlice;
  return {
    name: "orquester:excalidraw-assets",
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      const fonts = excalidrawFontsDir();
      const prefix = `${server.config.base.replace(/\/+$/, "")}/${ASSETS_DIR}/fonts/`;
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (!url?.startsWith(prefix)) return next();
        const file = normalize(join(fonts, decodeURIComponent(url.slice(prefix.length))));
        if (!file.startsWith(fonts + sep)) return next();
        stat(file).then(
          (info) => {
            if (!info.isFile()) return next();
            res.setHeader("Content-Type", "font/woff2");
            createReadStream(file).pipe(res);
          },
          () => next()
        );
      });
    },
    async writeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      await cp(excalidrawFontsDir(), join(outDir, ASSETS_DIR, "fonts"), { recursive: true });
    }
  };
}
