/**
 * The embed's CSS inside its shadow roots (design §5.7).
 *
 * - The base sheet (`styles.css`: Tailwind, agent-chat.css and the colour
 *   schemes, rewritten for a shadow root) is adopted by `adoptEmbedStyles`.
 * - Lazily loaded CSS (KaTeX's stylesheet) arrives through `adoptLazyStyles`:
 *   the embed build rewrites every side-effect CSS import on the embed path into
 *   a call to it (vite/embed-bundle.ts `embedCssImports`). It is adopted into
 *   every live embed root, and into each root adopted later.
 * - `@font-face` rules never register inside a shadow root, so they are taken
 *   out of both and written once to the document, in
 *   `<style data-orquester-embed-fonts="<build>">`, with absolute URLs on the
 *   Orquester that served the bundle.
 *
 * Nothing here touches the host page except that one `<style>` of font faces.
 */

import { absoluteUrls, splitFontFaces } from "./font-faces";
import baseCss from "./styles.css?inline";

declare const __ORQUESTER_BUILD__: string | undefined;

const BUILD = typeof __ORQUESTER_BUILD__ === "string" && __ORQUESTER_BUILD__ ? __ORQUESTER_BUILD__ : "unknown";

/** One stylesheet's text, and its constructed sheet once one was needed. */
interface EmbedSheet {
  css: string;
  constructed: CSSStyleSheet | null;
}

/** Every sheet so far, the base sheet first (lazily loaded CSS overrides it, as in the app's `<head>`). */
const sheets: EmbedSheet[] = [];
/** The CSS texts registered so far, as given. */
const registered = new Set<string>();
const roots = new Set<WeakRef<ShadowRoot>>();
const declaredFonts = new Set<string>();

function constructable(): boolean {
  return (
    typeof CSSStyleSheet !== "undefined" &&
    "replaceSync" in CSSStyleSheet.prototype &&
    typeof ShadowRoot !== "undefined" &&
    "adoptedStyleSheets" in ShadowRoot.prototype
  );
}

/** Declares `fontFaces` once on the document, in this build's font `<style>`. */
function declareFonts(fontFaces: string): void {
  if (!fontFaces || declaredFonts.has(fontFaces) || typeof document === "undefined") return;
  declaredFonts.add(fontFaces);
  let style = document.head.querySelector<HTMLStyleElement>(`style[data-orquester-embed-fonts="${CSS.escape(BUILD)}"]`);
  if (!style) {
    style = document.createElement("style");
    style.dataset.orquesterEmbedFonts = BUILD;
    document.head.append(style);
  }
  // Another copy of this same build (a second import) may have declared it already.
  if (!style.textContent?.includes(fontFaces)) style.append(document.createTextNode(`${fontFaces}\n`));
}

/** Registers `css` (once) and returns its sheet, or null when it was already registered. */
function addSheet(css: string): EmbedSheet | null {
  if (registered.has(css)) return null;
  const { fontFaces, rules } = splitFontFaces(css);
  registered.add(css);
  declareFonts(absoluteUrls(fontFaces, import.meta.url));
  const sheet: EmbedSheet = { css: rules, constructed: null };
  sheets.push(sheet);
  return sheet;
}

function adoptInto(root: ShadowRoot, adding: readonly EmbedSheet[]): void {
  if (constructable()) {
    const constructed = adding.map((sheet) => {
      if (!sheet.constructed) {
        sheet.constructed = new CSSStyleSheet();
        sheet.constructed.replaceSync(sheet.css);
      }
      return sheet.constructed;
    });
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...constructed];
    return;
  }
  // No constructable stylesheets: one <style> per sheet, ahead of the root's content.
  const styles = adding.map((sheet) => {
    const style = document.createElement("style");
    style.dataset.orquesterEmbed = "";
    style.textContent = sheet.css;
    return style;
  });
  const lastStyle = [...root.querySelectorAll(":scope > style[data-orquester-embed]")].pop();
  if (lastStyle) lastStyle.after(...styles);
  else root.prepend(...styles);
}

/**
 * Adopts the embed's CSS into `root`: the base sheet and every lazily loaded
 * sheet so far; sheets that load later are adopted as they arrive. Call it once
 * per shadow root, before rendering into it.
 */
export function adoptEmbedStyles(root: ShadowRoot): void {
  addSheet(baseCss);
  for (const ref of roots) if (ref.deref() === root) return;
  roots.add(new WeakRef(root));
  adoptInto(root, sheets);
}

/**
 * Registers lazily loaded CSS and adopts it into every live embed shadow root.
 * The embed build calls it for each side-effect CSS import on the embed path;
 * other code should not need to.
 */
export function adoptLazyStyles(css: string): void {
  addSheet(baseCss);
  const sheet = addSheet(css);
  if (!sheet) return;
  for (const ref of roots) {
    const root = ref.deref();
    if (root) adoptInto(root, [sheet]);
    else roots.delete(ref);
  }
}
