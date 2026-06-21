import { parseAppdir, startDaemon } from "./index";

async function main(): Promise<void> {
  const daemon = await startDaemon({
    appdir: parseAppdir(process.argv.slice(2)),
    cwd: process.cwd(),
    env: process.env
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // Safety net: if a graceful stop stalls (e.g. a connection that refuses to
    // drain), force-exit after a short grace period so systemd never has to wait
    // out TimeoutStopSec and SIGKILL us. The tmux server lives in its own process
    // tree and survives regardless (KillMode=process).
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    try {
      await daemon.stop();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
