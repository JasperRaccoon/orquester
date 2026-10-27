/**
 * A fake Linux box for Android box-host tests: `localBoxConnection()` (box ops run on this machine)
 * over a throwaway device root holding a scripted SDK and tools that behave like the real ones
 * where the host looks: `emulator` starts a `qemu-system-x86_64` process (a copy of `sleep`) and
 * records its arguments; `adb` answers `sys.boot_completed`, `emu kill` and the rest; the hub CLI
 * serves `/healthz` and a token-gated `/api/devices` and publishes its 0600 state file; agent-device
 * starts a detached daemon with `daemon.json`. The probe's answer is canned (KVM, ffmpeg and Java
 * need not exist here). For tests only.
 */

import { execFile } from "node:child_process";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ANDROID_SYSTEM_IMAGE, deviceProfile } from "@orquester/api";

import type { BoxExecOptions, BoxProcess } from "../../../boxes/contracts.ts";
import { ANDROID_CACHE_SOURCE, DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../../boxes/testing.ts";
import { avdHardware } from "../../android/avd-config.ts";
import { profileHash } from "../../toolchain/android-sdk.ts";
import { scrcpyJarPath } from "../../toolchain/npm-tools.ts";
import { ANDROID_PROBE_SCRIPT, BOX_GOLDEN_MARKER, BOX_GOLDEN_SNAPSHOT } from "./android-remote.ts";

const FAKE_EMULATOR = `#!/bin/sh
# Fake emulator: record the arguments, refuse a snapshot boot when told to, become "qemu".
root=$(cd "$(dirname "$0")/../.." && pwd)
printf '%s\\n' "$*" >> "$root/emulator-args.log"
port=
prev=
for arg in "$@"; do
  if [ "$prev" = -port ]; then port=$arg; fi
  prev=$arg
done
case " $* " in
  *" -snapshot "*) if [ -f "$root/fail-snapshot" ]; then echo "snapshot load failed" >&2; exit 1; fi ;;
esac
echo $$ > "$root/emu-$port.pid"
exec "$root/android-sdk/emulator/qemu/qemu-system-x86_64" 600
`;

const FAKE_ADB = `#!/bin/sh
root=$(cd "$(dirname "$0")/../.." && pwd)
case "$1" in
  start-server|kill-server|devices) exit 0 ;;
esac
serial=$2
shift 2
case "$1" in
  shell)
    case "$*" in
      *sys.boot_completed*) echo 1 ;;
    esac
    exit 0 ;;
  emu)
    port=\${serial#emulator-}
    if [ "$2" = kill ] && [ -f "$root/emu-$port.pid" ]; then kill "$(cat "$root/emu-$port.pid")" 2> /dev/null; rm -f "$root/emu-$port.pid"; fi
    echo OK
    exit 0 ;;
esac
exit 0
`;

const FAKE_HUB = `import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const token = randomBytes(16).toString("hex");
const server = createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  if (req.headers.authorization !== "Bearer " + token) { res.statusCode = 401; return res.end(); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ devices: [] }));
});
server.listen(port, "127.0.0.1", () => {
  writeFileSync(join(process.env.EXPO_DEVICE_HUB_STATE_DIR, "server-" + port + ".json"), JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
  console.log("hub ready at http://127.0.0.1:" + port + "/?token=" + token);
});
process.on("SIGTERM", () => process.exit(0));
`;

const FAKE_AGENT_DEVICE = `#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const state = process.env.AGENT_DEVICE_STATE_DIR;
const file = join(state, "daemon.json");
const command = process.argv[2];
if (command === "__serve") {
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => res.end(req.url === "/health" ? "ok" : "{}"));
  server.listen(0, "127.0.0.1", () => writeFileSync(file, JSON.stringify({ pid: process.pid, httpPort: server.address().port, token }), { mode: 0o600 }));
} else if (command === "devices") {
  if (!existsSync(file)) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "__serve"], { detached: true, stdio: "ignore", env: process.env }).unref();
    const end = Date.now() + 10000;
    while (!existsSync(file) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log("[]");
} else if (command === "daemon" && process.argv[3] === "stop") {
  try { process.kill(JSON.parse(readFileSync(file, "utf8")).pid, "SIGTERM"); } catch {}
  rmSync(file, { force: true });
}
`;

export interface FakeLinuxBoxOptions {
  /**
   * How the restored AVDs were made: `tuned` (default: the cache script's markers, the GPU mode
   * `cacheGpu` recorded) or `legacy` (an older cache's untuned 1080p AVD without markers).
   */
  cacheAvds?: "tuned" | "legacy";
  /** The GPU mode a tuned cache recorded (default `swiftshader_indirect`). */
  cacheGpu?: string;
  /** The probe's answer. */
  kvm?: "direct" | "sg" | "missing";
  ffmpeg?: "libx264" | "missing";
  cpus?: number;
  /** The fake box's MemAvailable, independent of the test host's current load (default 64 GiB). */
  memAvailableBytes?: number;
}

export interface FakeLinuxBox {
  root: string;
  connection: LocalBoxConnection;
  /** Every exec (command and args), in order. */
  execs: string[][];
  /** Every exec's env values (secrets must never appear). */
  envValues: string[];
  emulatorArgs(): Promise<string[]>;
  failSnapshotLoads(): Promise<void>;
  cleanup(): Promise<void>;
}

async function write(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  if (mode !== undefined) await chmod(path, mode);
}

export async function createFakeLinuxBox(options: FakeLinuxBoxOptions = {}): Promise<FakeLinuxBox> {
  const base = await mkdtemp(join(tmpdir(), "orq-linux-box-"));
  const root = join(base, "devices");
  const sdk = join(root, "android-sdk");
  await write(join(sdk, "emulator", "emulator"), FAKE_EMULATOR, 0o755);
  await write(join(sdk, "emulator", "source.properties"), "Pkg.Revision=37.2.12\n");
  await mkdir(join(sdk, "emulator", "qemu"), { recursive: true });
  await copyFile("/bin/sleep", join(sdk, "emulator", "qemu", "qemu-system-x86_64"));
  await write(join(sdk, "platform-tools", "adb"), FAKE_ADB, 0o755);
  await write(join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"), "#!/bin/sh\nexit 0\n", 0o755);
  await write(join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"), "#!/bin/sh\nexit 0\n", 0o755);
  await write(join(sdk, ...ANDROID_SYSTEM_IMAGE.split(";"), "system.img"), "");
  const profile = deviceProfile("pixel-9")!;
  const avd = join(root, "avd", `orq-${profile.id}.avd`);
  await write(join(root, "avd", `orq-${profile.id}.ini`), `path=${avd}\n`);
  await write(join(avd, "snapshots", BOX_GOLDEN_SNAPSHOT, "snapshot.pb"), "");
  if (options.cacheAvds === "legacy") {
    await write(join(avd, "config.ini"), `avd.name=orq-${profile.id}\nhw.lcd.width=1080\nhw.lcd.height=2424\nhw.lcd.density=420\n`);
  } else {
    // What the cache script writes (`boxes/github/device-cache.ts`): the tuned config and both markers.
    const hardware = avdHardware(profile);
    const configHash = profileHash(profile);
    await write(join(avd, "config.ini"), `avd.name=orq-${profile.id}\nhw.lcd.width=${hardware.width}\nhw.lcd.height=${hardware.height}\nhw.lcd.density=${hardware.density}\n`);
    await write(join(avd, "orq-avd.json"), JSON.stringify({ profile: profile.id, configHash, createdAt: "2026-10-27T00:00:00.000Z", deviceDensity: 420, source: ANDROID_CACHE_SOURCE }));
    await write(
      join(avd, BOX_GOLDEN_MARKER),
      JSON.stringify({ snapshot: BOX_GOLDEN_SNAPSHOT, gpu: options.cacheGpu ?? "swiftshader_indirect", configHash, emulatorRevision: "37.2.12", createdAt: "2026-10-27T00:00:00.000Z", source: ANDROID_CACHE_SOURCE })
    );
  }
  const tools = join(root, "tools", "node_modules");
  await write(join(tools, "expo-device-hub", "package.json"), JSON.stringify({ name: "expo-device-hub", version: DEVICE_TOOL_VERSIONS["expo-device-hub"] }));
  await write(join(tools, "expo-device-hub", "dist", "server", "cli.mjs"), FAKE_HUB);
  await write(join(tools, "agent-device", "package.json"), JSON.stringify({ name: "agent-device", version: DEVICE_TOOL_VERSIONS["agent-device"] }));
  await write(join(tools, "agent-device", "bin", "agent-device.mjs"), FAKE_AGENT_DEVICE, 0o755);
  await write(scrcpyJarPath(join(root, "tools")), "jar");
  const probe = [
    `path=${process.env.PATH}`,
    "os=Linux",
    "user=orquester",
    `node=${process.execPath}`,
    `node_version=${process.version}`,
    "npm=",
    `kvm=${options.kvm ?? "direct"}`,
    `ffmpeg=${options.ffmpeg ?? "libx264"}`,
    "java=1",
    "java_home=",
    "unzip=1",
    "sudo=0",
    `cpus=${options.cpus ?? 16}`
  ].join("\n");
  const execs: string[][] = [];
  const envValues: string[] = [];
  const connection = localBoxConnection({ boxId: "linux-box" });
  const exec = connection.exec.bind(connection);
  connection.exec = (spec: BoxExecOptions): BoxProcess => {
    execs.push([spec.command, ...(spec.args ?? [])]);
    envValues.push(...Object.values(spec.env ?? {}));
    if (spec.command === "/bin/sh" && spec.args?.[1] === ANDROID_PROBE_SCRIPT) return exec({ command: "/bin/sh", args: ["-c", 'printf "%s\\n" "$1"', "probe", probe] });
    if (spec.command === "cat" && spec.args?.length === 1 && spec.args[0] === "/proc/meminfo") {
      const memory = `MemAvailable: ${Math.floor((options.memAvailableBytes ?? 64 * 1024 ** 3) / 1024)} kB`;
      return exec({ command: "/bin/sh", args: ["-c", 'printf "%s\\n" "$1"', "memory", memory] });
    }
    return exec(spec);
  };
  return {
    root,
    connection,
    execs,
    envValues,
    emulatorArgs: async () => (await readFile(join(root, "emulator-args.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    failSnapshotLoads: () => writeFile(join(root, "fail-snapshot"), ""),
    async cleanup() {
      // Anything still running from this root (fake qemu, hub, agent-device daemon) goes.
      await new Promise<void>((resolve) => execFile("pkill", ["-f", root], () => resolve()));
      await rm(base, { recursive: true, force: true });
    }
  };
}
