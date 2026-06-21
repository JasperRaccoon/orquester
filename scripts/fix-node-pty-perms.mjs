#!/usr/bin/env node
/**
 * Ensure node-pty's prebuilt `spawn-helper` binary is executable.
 *
 * npm/pnpm can strip the exec bit when extracting node-pty's prebuilt
 * binaries. node-pty `posix_spawnp`'s `spawn-helper` for every PTY, so a
 * non-executable helper makes EVERY terminal/agent session fail with
 * "posix_spawnp failed" -> the daemon reports "Failed to create session".
 *
 * This restores the exec bit after install. No-op on Windows (which uses
 * conpty and has no spawn-helper).
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "win32") process.exit(0);

let fixed = 0;

/** chmod every prebuilds/<platform>/spawn-helper under a node-pty dir. */
function fixNodePty(nodePtyDir) {
  const prebuilds = join(nodePtyDir, "prebuilds");
  if (!existsSync(prebuilds)) return;
  for (const platformDir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platformDir, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111); // add execute for user/group/other
      fixed++;
    } catch {
      /* ignore: best-effort */
    }
  }
}

// pnpm layout: node_modules/.pnpm/node-pty@<ver>/node_modules/node-pty
const pnpmDir = "node_modules/.pnpm";
if (existsSync(pnpmDir)) {
  for (const entry of readdirSync(pnpmDir)) {
    if (entry.startsWith("node-pty@")) {
      fixNodePty(join(pnpmDir, entry, "node_modules", "node-pty"));
    }
  }
}
// npm / hoisted layout fallback
fixNodePty("node_modules/node-pty");

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] restored exec bit on ${fixed} spawn-helper binary(ies)`);
}
