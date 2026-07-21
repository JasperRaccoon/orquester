/**
 * Detects dev-server URLs in PTY output (Vite/Next/CRA banners), per project.
 * Keeps ORIGINS ONLY (no path/query — avoids token leaks), most recent first,
 * capped at 8. ANSI is stripped before matching. Pure and synchronous; the
 * per-chunk cost is one `includes("http")` guard.
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?/gi;
const MAX_PER_PROJECT = 8;

export class UrlWatcher {
  private readonly byProject = new Map<string, string[]>();

  ingest(projectPath: string, chunk: string): void {
    if (!projectPath || !chunk.includes("http")) return;
    const clean = chunk.replace(ANSI_RE, "");
    const matches = clean.match(URL_RE);
    if (!matches) return;
    const list = this.byProject.get(projectPath) ?? [];
    for (const raw of matches) {
      // Normalize 0.0.0.0 (bind-all banner) to localhost — that's what the
      // server-side Chromium should actually dial.
      const origin = raw.toLowerCase().replace("0.0.0.0", "localhost");
      const at = list.indexOf(origin);
      if (at !== -1) list.splice(at, 1);
      list.unshift(origin);
    }
    this.byProject.set(projectPath, list.slice(0, MAX_PER_PROJECT));
  }

  suggestions(projectPath: string): string[] {
    return this.byProject.get(projectPath) ?? [];
  }
}
