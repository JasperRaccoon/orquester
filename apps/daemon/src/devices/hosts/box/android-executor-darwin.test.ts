import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { localBoxConnection } from "../../../boxes/testing.ts";
import { readProcStat } from "../../android/procs.ts";
import { boxDarwinExecutor, parseDarwinEnviron, parseDarwinPs, parseNetstatTcp, parseVmStat } from "./android-executor-darwin.ts";

// Output captured on an M4 Max (macOS 26.2), user and addresses redacted.
const PS = `    1     0     1 Ss     1:15.41 Sun Nov 22 04:07:38 2026     launchd
25467 25464 25464 S      0:00.00 Sun Nov 22 06:32:17 2026     sshd-session
31002 31001 31001 S    1:02:03.50 Sun Nov 22 06:30:01 2026     qemu-system-aarc
31003 31002 31001 Z      0:00.00 Sun Nov 22 06:30:02 2026     adb
`;
const ENVIRON =
  "/Users/owner/.orquester/devices/android/android-sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd orq-pixel-9 -no-window -gpu host " +
  "ANDROID_AVD_HOME=/Users/owner/.orquester/devices/android/avd SHELL=/bin/zsh SSH_CLIENT=192.0.2.10 34912 22 HOME=/Users/owner/.orquester/devices/android/home\n";
const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  192.168.2.14.52583     198.51.100.7.443       ESTABLISHED
tcp4       0      0  127.0.0.1.21877        127.0.0.1.52590        ESTABLISHED
tcp4       0      0  127.0.0.1.21877        *.*                    LISTEN
tcp46      0      0  *.58143                *.*                    LISTEN
tcp4      24      0  192.168.2.14.65030     203.0.113.5.443        CLOSE_WAIT
udp4       0      0  *.5353                 *.*
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              187518.
Pages active:                            631251.
Pages inactive:                         1206682.
Pages speculative:                        26405.
Pages throttled:                              0.
Pages wired down:                        240758.
`;

describe("the Mac's process and memory reads", () => {
  it("reads ps, ps -E, netstat and vm_stat output from a Mac", () => {
    const stats = parseDarwinPs(PS);
    const qemu = stats.find((stat) => stat.pid === 31002)!;
    assert.ok(qemu.comm.startsWith("qemu-system"), "what finds and verifies an emulator's QEMU process");
    assert.equal(qemu.pgrp, 31001);
    assert.equal(qemu.cpuTicks, (3600 + 2 * 60 + 3.5) * 100);
    assert.equal(qemu.startTicks, Date.UTC(2026, 10, 22, 6, 30, 1) / 1000);
    assert.equal(stats.find((stat) => stat.pid === 31003)!.state, "Z");

    const env = parseDarwinEnviron(ENVIRON)!;
    assert.equal(env.get("ANDROID_AVD_HOME"), "/Users/owner/.orquester/devices/android/avd");
    assert.equal(env.get("SSH_CLIENT"), "192.0.2.10 34912 22");
    assert.equal(env.get("HOME"), "/Users/owner/.orquester/devices/android/home");
    assert.equal(parseDarwinEnviron(""), null);

    const rows = parseNetstatTcp(NETSTAT);
    assert.deepEqual(rows.filter((row) => row.state === "0A").map((row) => row.localPort).sort(), [21877, 58143]);
    assert.equal(rows.filter((row) => row.state === "01" && row.localPort === 21877).length, 1);

    assert.equal(parseVmStat(VM_STAT), (187518 + 1206682 + 26405) * 16384);
    assert.equal(parseVmStat("vm_stat: not found"), null);
  });

  it("starts a detached program in its own session without setsid", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "orq-darwin-exec-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const link = localBoxConnection({ boxId: "mac1" });
    const x = boxDarwinExecutor(() => link);
    const log = join(dir, "logs", "child.log");
    const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: dir };
    const pid = await x.spawnDetached(process.execPath, ["-e", 'console.log("started"); setInterval(() => undefined, 1000)'], { env, logPath: log });
    t.after(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    });
    // It leads its own process group (setsid's effect), so a hang-up of the exec's group never reaches it.
    const stat = await readProcStat(pid);
    assert.ok(stat, "the detached program runs");
    assert.equal(stat.pgrp, pid);
    // The same read through `ps` (the Mac's way; procps takes the same columns).
    const viaPs = await x.procStat(pid);
    assert.equal(viaPs?.pgrp, pid);
    assert.equal(typeof viaPs?.startTicks, "number");
    // Its output goes to the log, made 0600 before it starts.
    assert.equal(statSync(log).mode & 0o777, 0o600);
  });
});
