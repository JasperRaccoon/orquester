export interface AddonDef {
  id: string;
  name: string;
  description: string;
  bin: readonly string[];
  versionFlag?: string;
  installCmd?: string;
  updateCmd?: string;
  readmeMarkdown: string;
}

/** Static defs without the large README string (filled in addons.ts). */
export const ADDONS: readonly Omit<AddonDef, "readmeMarkdown">[] = [
  {
    id: "teamclaude",
    name: "TeamClaude",
    description: "Multi-account Claude proxy with automatic quota-based rotation for Claude Code.",
    bin: ["teamclaude"] as const,
    versionFlag: "version",
    installCmd: "npm install -g @karpeleslab/teamclaude",
    updateCmd: "npm update -g @karpeleslab/teamclaude"
  }
] as const;
