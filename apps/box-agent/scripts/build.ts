// `pnpm --filter @orquester/box-agent build [--out DIR] [--version V] [platform…]`
// Builds orq-agent for every platform (or the ones named) into dist/ (default).
import { join } from "node:path";

import { BOX_AGENT_SOURCE_DIR, boxAgentVersion, buildBoxAgent } from "../src/build.ts";

const args = process.argv.slice(2);
let outDir = join(BOX_AGENT_SOURCE_DIR, "dist");
let version: string | null = null;
const platforms: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out") outDir = args[++i]!;
  else if (arg === "--version") version = args[++i]!;
  else platforms.push(arg);
}

try {
  const manifest = await buildBoxAgent({
    outDir,
    version: version ?? (await boxAgentVersion()),
    platforms: platforms.length > 0 ? platforms : undefined
  });
  console.log(`orq-agent ${manifest.version}: ${Object.keys(manifest.platforms).join(", ")} → ${outDir}`);
} catch (error) {
  console.error(`orq-agent build failed: ${(error as Error).message}`);
  process.exit(1);
}
