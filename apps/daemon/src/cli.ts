import { parseAppdir, startDaemon } from "./index";

async function main(): Promise<void> {
  const daemon = await startDaemon({
    appdir: parseAppdir(process.argv.slice(2)),
    cwd: process.cwd(),
    env: process.env
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
