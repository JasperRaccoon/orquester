import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context, build, type BuildOptions } from "esbuild";

const watch = process.argv.includes("--watch");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist-electron", "main.cjs");

const options: BuildOptions = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron", "node-pty"],
  logLevel: "info"
};

if (watch) {
  await rm(outfile, { force: true });
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching Electron main process...");
} else {
  await build(options);
}
