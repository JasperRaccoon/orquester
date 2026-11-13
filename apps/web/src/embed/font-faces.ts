/**
 * `@font-face` rules do not register inside a shadow root (Chromium), so the
 * embed's CSS keeps them out of the adopted sheets and declares them on the
 * document instead (styles.ts).
 */

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;
const URL_TOKEN = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/** `css` split into its `@font-face` rules and everything else. */
export function splitFontFaces(css: string): { fontFaces: string; rules: string } {
  const faces = css.match(FONT_FACE) ?? [];
  return { fontFaces: faces.join("\n"), rules: faces.length > 0 ? css.replace(FONT_FACE, "") : css };
}

/**
 * Every relative `url(…)` in `css` resolved against `base` (the bundle's own
 * URL), so the rules keep pointing at the Orquester that served the bundle once
 * they sit in the host page's document.
 */
export function absoluteUrls(css: string, base: string): string {
  return css.replace(URL_TOKEN, (match, _quote: string, url: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) return match;
    return `url(${JSON.stringify(new URL(url, base).href)})`;
  });
}
