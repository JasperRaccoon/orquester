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
