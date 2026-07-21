import type { BrowserPickPayload } from "@orquester/api";

export type PickIntent = "fix" | "change" | "question";

/**
 * Render a pick into the Markdown block pasted into an agent's PTY (Orca's
 * "Design Feedback" format). The screenshot is referenced by daemon-side path
 * (uploaded via the session-upload route) — agents like Claude Code read image
 * paths natively.
 */
export function formatDesignFeedback(
  payload: BrowserPickPayload,
  opts: { comment: string; intent: PickIntent; screenshotPath?: string }
): string {
  const { page, target } = payload;
  const lines: string[] = [
    `## Design Feedback: ${target.elementPath || target.selector}`,
    "",
    `**URL:** ${page.url}`,
    `**Viewport:** ${page.viewport.width}×${page.viewport.height} (${page.viewportMode})`,
    `**Intent:** ${opts.intent}`,
    "",
    `**Selector:** \`${target.selector}\``
  ];
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
  if (opts.screenshotPath) lines.push("", `**Screenshot:** ${opts.screenshotPath}`);
  lines.push("", `**Feedback:** ${opts.comment.trim() || "(none)"}`);
  return lines.join("\n");
}
