/**
 * Shortcut strings → the glyphs a `Kbd` renders.
 *
 * Keybindings are written once, platform-neutrally, as `mod+shift+enter`; this
 * is the only place that decides `mod` means ⌘ or Ctrl. Writing "Cmd/Ctrl+K"
 * in a hint string instead is how a UI ends up telling a Linux user about a
 * key their keyboard does not have.
 */

/** `true` on macOS-like platforms. Safe to call during SSR (returns false). */
export function isAppleLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
}

const APPLE_GLYPHS: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  enter: "↵",
  return: "↵",
  escape: "Esc",
  esc: "Esc",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→"
};

const OTHER_GLYPHS: Record<string, string> = {
  mod: "Ctrl",
  cmd: "Ctrl",
  meta: "Win",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  escape: "Esc",
  esc: "Esc",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→"
};

/**
 * Splits `"mod+shift+enter"` into the glyphs to render, in the canonical
 * modifier order (⌃ ⌥ ⇧ ⌘ on Apple, Ctrl Alt Shift on everything else) so two
 * hints for the same chord never disagree about order. Unknown tokens pass
 * through upper-cased; empty segments are dropped, so a stray `"a++b"` or a
 * trailing `+` cannot produce a blank key cap.
 */
export function shortcutKeys(combo: string, apple = isAppleLike()): string[] {
  const glyphs = apple ? APPLE_GLYPHS : OTHER_GLYPHS;
  const order = apple ? ["ctrl", "alt", "shift", "mod"] : ["mod", "ctrl", "alt", "shift"];
  const tokens = combo
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  const modifiers: string[] = [];
  const rest: string[] = [];
  for (const token of tokens) {
    const canonical = token === "cmd" || token === "meta" ? "mod" : token;
    const isModifier =
      canonical === "mod" || canonical === "ctrl" || canonical === "alt" || canonical === "shift";
    if (isModifier) {
      // Dedupe: `mod+cmd+k` is one ⌘, not two.
      if (!modifiers.includes(canonical)) modifiers.push(canonical);
    } else {
      rest.push(canonical);
    }
  }
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, ...rest].map(
    (token) => glyphs[token] ?? (token.length === 1 ? token.toUpperCase() : token)
  );
}
