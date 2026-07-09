import type { AddonDef } from "./addons-data";
import { ADDONS } from "./addons-data";
import { TEAMCLAUDE_README } from "./teamclaude-readme";

export type { AddonDef };

/** Static catalog of installable companion addons (not launchable sessions). */
export const ADDONS_CATALOG: readonly AddonDef[] = ADDONS.map((a): AddonDef => ({
  ...a,
  readmeMarkdown: a.id === "teamclaude" ? TEAMCLAUDE_README : ""
}));
