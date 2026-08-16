/*
 * Stamps the persisted theme on <html> before the app bundle loads, so a
 * light/non-default scheme never flashes the stock dark palette. Mirrors the
 * resolution rules in packages/ui/src/lib/theme.ts (system -> matchMedia,
 * dynamic -> 07:00/19:00 bounds); any failure leaves the CSS default, dark.
 *
 * Byte-identical to apps/web/public/theme-boot.js (bar this note). It is a file
 * rather than an inline <script> there because the production Caddy CSP is
 * `script-src 'self'`; the desktop keeps the same shape so the two hosts boot
 * the theme the same way.
 */
(function () {
  try {
    var p = JSON.parse(localStorage.getItem("orquester:theme") || "{}");
    var schemes = ["mono", "warm", "slate", "rose", "matcha", "dune", "amethyst"];
    var h = new Date().getHours();
    var m = p.mode;
    if (m === "system") m = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    else if (m === "dynamic") m = h >= 19 || h < 7 ? "dark" : "light";
    else if (m !== "light") m = "dark";
    var r = document.documentElement;
    r.dataset.scheme = schemes.indexOf(p.scheme) >= 0 ? p.scheme : "mono";
    r.dataset.mode = m;
    r.style.colorScheme = m;
  } catch (e) {
    /* no stamp: the stylesheet's own default (dark) stands */
  }
})();
