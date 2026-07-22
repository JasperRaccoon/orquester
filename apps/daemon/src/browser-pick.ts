import type { BrowserPickPayload, BrowserPickTarget } from "@orquester/api";

// Hard budgets — the page is hostile; everything it reports gets re-clamped
// here regardless of what the in-page script promised. (Pattern from Orca's
// clampGrabPayload: guest-side budget + independent daemon-side re-validation.)
export const HTML_SNIPPET_MAX = 4096;
export const TEXT_SNIPPET_MAX = 400;
export const SELECTOR_MAX = 512;
export const ELEMENT_PATH_MAX = 512;
export const ATTR_VALUE_MAX = 256;
export const MAX_CLASSES = 24;
export const MAX_REACT_COMPONENTS = 8;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

const ATTR_ALLOW = new Set([
  "id", "class", "name", "type", "role", "href", "src", "alt",
  "title", "placeholder", "for", "action", "method"
]);

const SECRET_RE =
  /(access_token|api[_-]?key|authorization|cookie|csrf|password|secret|bearer|session[_-]?id)[=:][^&\s"']*/gi;

const STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "color",
  "background-color", "border", "border-radius", "font-family", "font-size",
  "font-weight", "line-height", "text-align", "z-index"
] as const;

// C0/C1 control chars minus \t and \n. Stripped because the picked payload is
// delivered into a PTY as a bracketed paste (\x1b[200~…\x1b[201~\r); a raw ESC
// in page text (e.g. the sequence \x1b[201~) would break out of the paste and
// let the following bytes run as typed keystrokes — a command injection.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function str(v: unknown, max: number): string {
  // Redact BEFORE slicing so the replacement can't push us over `max` and so a
  // secret straddling the cap boundary is still fully caught; strip control
  // chars at the same boundary so hostile page output can't inject into a PTY.
  return typeof v === "string"
    ? v.replace(CONTROL_RE, "").replace(SECRET_RE, "$1=<redacted>").slice(0, max)
    : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

function stripUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Re-validate a raw payload reported by the in-page picker script. Returns a
 * fresh object built field-by-field (never the input), or null when the shape
 * is not salvageable. Screenshot is attached later by the manager (it comes
 * from CDP, not from the page).
 */
export function clampBrowserPickPayload(raw: unknown): BrowserPickPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, any>;
  const page = r.page, target = r.target;
  if (typeof page !== "object" || page === null) return null;
  if (typeof target !== "object" || target === null) return null;
  if (typeof target.selector !== "string" || typeof target.tagName !== "string") return null;

  const attributes: Record<string, string> = {};
  if (typeof target.attributes === "object" && target.attributes !== null) {
    for (const [k, v] of Object.entries(target.attributes as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (ATTR_ALLOW.has(key) || key.startsWith("aria-")) {
        attributes[key] = str(v, ATTR_VALUE_MAX);
      }
    }
  }

  const computedStyles: Record<string, string> = {};
  if (typeof target.computedStyles === "object" && target.computedStyles !== null) {
    for (const prop of STYLE_PROPS) {
      const v = (target.computedStyles as Record<string, unknown>)[prop];
      if (typeof v === "string") computedStyles[prop] = v.replace(CONTROL_RE, "").slice(0, 128);
    }
  }

  const rect = target.rectViewport ?? {};
  const clamped: BrowserPickTarget = {
    tagName: str(target.tagName, 64).toLowerCase(),
    selector: str(target.selector, SELECTOR_MAX),
    elementPath: str(target.elementPath, ELEMENT_PATH_MAX),
    cssClasses: Array.isArray(target.cssClasses)
      ? target.cssClasses.slice(0, MAX_CLASSES).map((c: unknown) => str(c, 96))
      : [],
    attributes,
    computedStyles,
    rectViewport: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    accessibility: {
      role: str(target.accessibility?.role, 64),
      name: str(target.accessibility?.name, 200)
    },
    textSnippet: str(target.textSnippet, TEXT_SNIPPET_MAX),
    htmlSnippet: str(target.htmlSnippet, HTML_SNIPPET_MAX)
  };
  if (typeof target.reactSource === "string" && target.reactSource) {
    clamped.reactSource = str(target.reactSource, 300);
  }
  if (Array.isArray(target.reactComponents) && target.reactComponents.length > 0) {
    clamped.reactComponents = target.reactComponents
      .slice(0, MAX_REACT_COMPONENTS)
      .map((c: unknown) => str(c, 96));
  }

  return {
    page: {
      url: stripUrl(page.url),
      title: str(page.title, 200),
      viewport: { width: num(page.viewport?.width), height: num(page.viewport?.height) },
      viewportMode: page.viewportMode === "mobile" ? "mobile" : "desktop"
    },
    target: clamped
  };
}

/** Expression evaluated to arm/disarm the picker after PICKER_SCRIPT is installed. */
export function armPickerExpression(on: boolean): string {
  return `window.__orqPicker && window.__orqPicker.${on ? "arm" : "disarm"}()`;
}

/**
 * In-page picker (Orca "grab" design, remoted): a shadow-DOM overlay
 * click-catcher; elementFromPoint hit-testing; on click, extract a budgeted
 * payload and report it through the CDP binding window.__orquesterPick.
 * Idempotent: installing twice is a no-op. Runs in the page's main world.
 */
export const PICKER_SCRIPT = String.raw`
(() => {
  if (window.__orqPicker) return;
  const MAXH = ${HTML_SNIPPET_MAX}, MAXT = ${TEXT_SNIPPET_MAX};
  let host = null, box = null, label = null, current = null, armed = false;

  function ensureOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const root = host.attachShadow({ mode: "open" });
    box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;border:2px solid #38bdf8;background:rgba(56,189,248,.15);";
    label = document.createElement("div");
    label.style.cssText = "position:fixed;pointer-events:none;background:#0c4a6e;color:#e0f2fe;font:11px monospace;padding:2px 6px;border-radius:3px;max-width:60vw;overflow:hidden;white-space:nowrap;";
    root.append(box, label);
    host.addEventListener("mousemove", onMove, true);
    host.addEventListener("click", onClick, true);
    host.addEventListener("contextmenu", (e) => { e.preventDefault(); disarm(); }, true);
  }

  function under(x, y) {
    host.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    host.style.pointerEvents = "all";
    return el && el !== document.documentElement && el !== document.body ? el : null;
  }

  function onMove(e) {
    current = under(e.clientX, e.clientY);
    if (!current) { box.style.display = label.style.display = "none"; return; }
    const r = current.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
    // Self-calibrate against page zoom / root scale. Apps that set a global
    // `zoom:` (or transform scale) on html/body/#root put the overlay's
    // styling space and getBoundingClientRect space out of sync, so the
    // highlight lands offset and mis-sized. Both the target rect `r` and the
    // just-placed box are measured with the SAME API in the SAME space, so
    // the discrepancy is a linear map: fix scale first, then any residual
    // translation. No-ops (0 extra style writes) on unzoomed pages.
    let f = 1;
    const b1 = box.getBoundingClientRect();
    if (r.width > 0 && b1.width > 0 && Math.abs(b1.width - r.width) > 0.5) {
      f = b1.width / r.width;
      box.style.left = r.left / f + "px"; box.style.top = r.top / f + "px";
      box.style.width = r.width / f + "px"; box.style.height = r.height / f + "px";
    }
    const b2 = box.getBoundingClientRect();
    if (Math.abs(b2.left - r.left) > 0.5 || Math.abs(b2.top - r.top) > 0.5) {
      box.style.left = (parseFloat(box.style.left) + (r.left - b2.left) / f) + "px";
      box.style.top = (parseFloat(box.style.top) + (r.top - b2.top) / f) + "px";
    }
    const boxLeft = parseFloat(box.style.left);
    const boxTop = parseFloat(box.style.top);
    label.style.display = "block";
    label.style.left = boxLeft + "px";
    label.style.top = (boxTop > 24 ? boxTop - 22 : boxTop + r.height / f + 4) + "px";
    label.textContent = current.tagName.toLowerCase()
      + (current.id ? "#" + current.id : "")
      + " " + Math.round(r.width) + "×" + Math.round(r.height);
  }

  function cssPath(el) {
    // Bottom-up unique selector: prefer #id; else tag:nth-of-type, verified unique.
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
      node = parent;
    }
    return parts.join(" > ");
  }

  function readable(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 8; i++, node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase()
        + (node.id ? "#" + node.id : "")
        + (node.classList.length ? "." + node.classList[0] : ""));
    }
    return parts.join(" > ");
  }

  function react(el) {
    // Walk React fiber for component names + _debugSource (dev builds only).
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return {};
    const names = []; let source;
    let fiber = el[key];
    for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
      const t = fiber.type;
      const name = typeof t === "function" ? (t.displayName || t.name) : null;
      if (name && names.length < 8 && names[names.length - 1] !== name) names.push(name);
      const d = fiber._debugSource;
      if (!source && d && d.fileName) source = d.fileName + ":" + d.lineNumber + ":" + (d.columnNumber ?? 0);
    }
    return { reactSource: source, reactComponents: names.length ? names : undefined };
  }

  function extract(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const p of ["display","position","width","height","margin","padding","color",
                     "background-color","border","border-radius","font-family","font-size",
                     "font-weight","line-height","text-align","z-index"]) {
      styles[p] = cs.getPropertyValue(p);
    }
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const clone = el.cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll("script,style").forEach((n) => n.remove());
    const rx = react(el);
    return {
      page: {
        url: location.href, title: document.title,
        viewport: { width: innerWidth, height: innerHeight }
      },
      target: {
        tagName: el.tagName, selector: cssPath(el), elementPath: readable(el),
        cssClasses: Array.from(el.classList).slice(0, 24),
        attributes: attrs, computedStyles: styles,
        rectViewport: { x: r.left, y: r.top, width: r.width, height: r.height },
        accessibility: {
          role: el.getAttribute("role") || "",
          name: el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || ""
        },
        textSnippet: (el.innerText || "").slice(0, MAXT),
        htmlSnippet: (clone.outerHTML || "").slice(0, MAXH),
        ...rx
      }
    };
  }

  function onClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!current) return;
    let payload;
    try { payload = extract(current); } catch (err) { payload = { error: String(err) }; }
    disarm();
    try { window.__orquesterPick(JSON.stringify(payload)); } catch {}
  }

  function arm() {
    if (armed) return; armed = true;
    ensureOverlay();
    document.documentElement.appendChild(host);
  }
  function disarm() {
    armed = false; current = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (box) box.style.display = "none";
    if (label) label.style.display = "none";
  }
  window.__orqPicker = { arm, disarm };
})();
`;
