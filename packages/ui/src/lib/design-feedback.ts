import type { BrowserPickPayload } from "@orquester/api";

export type PickIntent = "fix" | "change" | "question";

// C0/C1 control chars minus \t and \n. The feedback markdown is delivered into
// an agent's PTY as a bracketed paste (\x1b[200~…\x1b[201~\r); a raw ESC in the
// (hostile) page-derived snippets — e.g. the literal bytes \x1b[201~ — would end
// paste mode early and let the following bytes run as typed keystrokes, a
// command injection. The daemon re-clamps too, but strip client-side as well so
// the wrap is never fed control bytes regardless of what reached the client.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Render one or more picks into the Markdown block pasted into an agent's PTY (Orca's
 * "Design Feedback" format). The screenshot is referenced by daemon-side path
 * (uploaded via the session-upload route) — agents like Claude Code read image
 * paths natively.
 */
export function formatDesignFeedback(
  picks: Array<{ payload: BrowserPickPayload; screenshotPath?: string }>,
  opts: { comment: string; intent: PickIntent }
): string {
  if (picks.length === 0) return "";
  const first = picks[0].payload;
  const single = picks.length === 1;
  const lines: string[] = [
    single
      ? `## Design Feedback: ${first.target.elementPath || first.target.selector}`
      : `## Design Feedback: ${picks.length} elements`,
    "",
    `**URL:** ${first.page.url}`,
    `**Viewport:** ${first.page.viewport.width}×${first.page.viewport.height} (${first.page.viewportMode})`,
    `**Intent:** ${opts.intent}`
  ];
  picks.forEach(({ payload, screenshotPath }, i) => {
    const { page, target } = payload;
    lines.push("");
    if (!single) {
      lines.push(`### Element ${i + 1}: ${target.elementPath || target.selector}`, "");
      // Picks can straddle a navigation (the batch accumulates across re-arms).
      if (page.url !== first.page.url) lines.push(`**URL:** ${page.url}`);
    }
    lines.push(`**Selector:** \`${target.selector}\``);
    if (target.reactSource) lines.push(`**Source:** ${target.reactSource}`);
    if (target.reactComponents?.length) lines.push(`**React:** ${target.reactComponents.join(" > ")}`);
    lines.push(
      `**Bounds:** ${Math.round(target.rectViewport.width)}×${Math.round(target.rectViewport.height)} at (${Math.round(target.rectViewport.x)}, ${Math.round(target.rectViewport.y)})`
    );
    if (target.cssClasses.length) lines.push(`**Classes:** ${target.cssClasses.join(" ")}`);
    if (target.accessibility.role || target.accessibility.name) {
      lines.push(`**Accessibility:** role=${target.accessibility.role || "-"} name="${target.accessibility.name}"`);
    }
    if (target.textSnippet) lines.push(`**Text:** ${target.textSnippet}`);
    const styles = Object.entries(target.computedStyles);
    if (styles.length) {
      lines.push("", "**Computed styles:**");
      for (const [prop, value] of styles) lines.push(`- ${prop}: ${value}`);
    }
    if (target.htmlSnippet) lines.push("", "**HTML:**", "```html", target.htmlSnippet, "```");
    if (screenshotPath) lines.push("", `**Screenshot:** ${screenshotPath}`);
  });
  lines.push("", `**Feedback:** ${opts.comment.trim() || "(none)"}`);
  return lines.join("\n").replace(CONTROL_RE, "");
}
