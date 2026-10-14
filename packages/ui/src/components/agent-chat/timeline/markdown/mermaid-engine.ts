import { createMermaidRenderer, type MermaidEngine, type MermaidRenderer } from "./mermaid-render";
import { createMermaidSvgSanitizer } from "./mermaid-svg";

let enginePromise: Promise<MermaidEngine> | null = null;

/** The one `import("mermaid")` in the app; a failed load is forgotten so a retry can try again. */
function loadMermaid(): Promise<MermaidEngine> {
  enginePromise ??= import("mermaid")
    .then((module) => module.default as unknown as MermaidEngine)
    .catch((error: unknown) => {
      enginePromise = null;
      throw error;
    });
  return enginePromise;
}

let shared: MermaidRenderer | null = null;

/** The renderer every diagram in the app shares (one queue, one cache). */
export function getMermaidRenderer(): MermaidRenderer {
  shared ??= createMermaidRenderer({
    loadMermaid,
    sanitize: createMermaidSvgSanitizer(window),
    fontFamily: () => getComputedStyle(document.body).fontFamily,
    // `mermaid.render` parks a scratch node `#d<id>` in the body and only
    // removes it on success.
    cleanup: (id) => document.getElementById(`d${id}`)?.remove()
  });
  return shared;
}
