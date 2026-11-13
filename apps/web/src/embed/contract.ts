/**
 * The embed's public contract (docs/embed-agent-chat.md), shared by the element
 * and the build that writes `dist/embed/manifest.json`.
 *
 * `EMBED_CONTRACT` is bumped only on a breaking change to the element's API, its
 * events, the `--orq-*` names or the frames it accepts; additive changes keep it.
 */
export const EMBED_CONTRACT = 1;

/** The tag `define()` registers by default. */
export const EMBED_ELEMENT = "orquester-agent-chat";

/**
 * The class of the wrapper inside the shadow root. It carries `data-mode` and
 * `data-scheme`, and the embed's CSS targets it where the app's targets `body`.
 */
export const EMBED_ROOT_CLASS = "orq-embed-root";

/**
 * What a failed lazy chunk of the embed dispatches on `window`, in place of
 * Vite's shared `vite:preloadError`: the build renames it in the embed's
 * preload helper (`embedPreloadErrorEvent`, `vite/embed-bundle.ts`), so a host
 * page's own Vite chunks and the embed's never hear each other's failures.
 */
export const EMBED_PRELOAD_ERROR_EVENT = "orquester-embed:preloadError";
