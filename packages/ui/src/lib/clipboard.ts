/**
 * Write text to the clipboard, working in non-secure contexts too.
 *
 * `navigator.clipboard` only exists on secure origins (HTTPS / localhost) and in
 * Electron — the production Caddy deploy qualifies. When the daemon is reached over
 * plain `http://` (a LAN IP), that API is absent, so fall back to the legacy
 * hidden-<textarea> + execCommand path. Both run from a user gesture (a menu-item
 * tap), which iOS Safari / Android Chrome require.
 *
 * Resolves to whether the copy went through, so a caller can avoid claiming
 * "Copied" when it did not; it never rejects.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied / blocked — fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    /* clipboard unavailable — give up silently */
    return false;
  }
}
