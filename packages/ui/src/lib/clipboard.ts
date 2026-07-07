/**
 * Write text to the clipboard, working in non-secure contexts too.
 *
 * `navigator.clipboard` only exists on secure origins (HTTPS / localhost) and in
 * Electron — the production Caddy deploy qualifies. When the daemon is reached over
 * plain `http://` (a LAN IP), that API is absent, so fall back to the legacy
 * hidden-<textarea> + execCommand path. Both run from a user gesture (a menu-item
 * tap), which iOS Safari / Android Chrome require.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
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
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    /* clipboard unavailable — give up silently */
  }
}
