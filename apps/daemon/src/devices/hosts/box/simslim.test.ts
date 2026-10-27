import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SIMSLIM_INSTALL_SCRIPT, SIMSLIM_RELEASE } from "../../../boxes/github/device-cache.ts";
import {
  ORQ_SLIM_PROFILE_JSON,
  isPinnedSimslim,
  isSlim,
  parseSimslimInstall,
  parseSimslimTop,
  parseSimslimVerify,
  simslimBin,
  simslimMeasureArgs,
  simslimOnArgs,
  simslimProfilePath,
  simslimTopArgs,
  simslimVerifyArgs,
  slimmableIos
} from "./simslim.ts";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/simslim/${name}`, import.meta.url), "utf8");

describe("simslim", () => {
  it("builds the commands the host runs in the default device set", () => {
    const profilePath = simslimProfilePath("/var/lib/orquester/devices");
    assert.equal(profilePath, "/var/lib/orquester/devices/simslim-profile.json");
    assert.equal(simslimBin("/var/lib/orquester/devices/tools"), "/var/lib/orquester/devices/tools/simslim/v0.13.0/simslim");
    assert.deepEqual(simslimOnArgs({ udid: "U1", profilePath }), ["on", "U1", "--profile", profilePath]);
    assert.deepEqual(simslimOnArgs({ udid: "U1", profilePath, preserveBootState: true }), ["on", "U1", "--profile", profilePath, "--preserve-boot-state"]);
    assert.deepEqual(simslimOnArgs({ udid: "U1", profilePath, noReboot: true }), ["on", "U1", "--profile", profilePath, "--no-reboot"]);
    assert.deepEqual(simslimVerifyArgs({ udid: "U1", profilePath }), ["verify", "U1", "--profile", profilePath, "--json"]);
    assert.deepEqual(simslimTopArgs(), ["top", "--json"]);
    assert.deepEqual(simslimMeasureArgs("U1"), ["measure", "U1", "--json"]);
  });

  it("writes a profile simslim accepts: known fields only, managed labels kept", () => {
    const parsed = JSON.parse(ORQ_SLIM_PROFILE_JSON) as Record<string, unknown>;
    // `SlimProfile` decodes with DisallowUnknownFields.
    assert.deepEqual(Object.keys(parsed).sort(), ["description", "except", "keep", "name"]);
    assert.deepEqual(parsed.keep, ["com.apple.apsd", "com.apple.swcd", "com.apple.assetsd"]);
    assert.deepEqual(parsed.except, []);
  });

  it("gates on iOS 18.5, the first runtime whose overrides persist", () => {
    for (const version of ["18.5", "18.6", "26.2", "27.0", "19"]) assert.equal(slimmableIos(version), true, version);
    for (const version of ["18.4.1", "18.3", "17.5", "", "abc"]) assert.equal(slimmableIos(version), false, version);
  });

  it("parses `top --json` (TopOutput)", () => {
    const top = parseSimslimTop(fixture("top.json"));
    assert.ok(top);
    assert.equal(top.totalBytes, 5_261_334_937);
    assert.equal(top.sims.length, 3);
    assert.deepEqual(top.sims[0], {
      udid: "6F1C2E9A-3B7D-4E21-9C55-0A8B1D2E3F40",
      name: "orq-L1",
      state: "Booted",
      osVersion: "27.0",
      managedDisabled: 173,
      managedTotal: 176,
      memory: { processes: 71, bytes: 966_367_641, cpu: 3.4 }
    });
    assert.equal(isSlim(top.sims[0]!), true);
    assert.equal(isSlim(top.sims[1]!), false, "the owner's stock simulator");
    assert.deepEqual([top.sims[2]!.managedDisabled, top.sims[2]!.memory], [null, null], "unreadable status and memory");
    assert.deepEqual(parseSimslimTop(fixture("top-empty.json")), { sims: [], totalBytes: 0 });
    // Captured on a Blacksmith Mac: three slim simulators, 0.59–0.68 GiB each.
    const captured = parseSimslimTop(fixture("top-captured.json"));
    assert.equal(captured?.sims.length, 3);
    assert.ok(captured?.sims.every((entry) => isSlim(entry) && entry.memory !== null && entry.memory.bytes < 0.75 * 1024 ** 3));
    assert.equal(parseSimslimTop("not json"), null);
    assert.equal(parseSimslimTop(JSON.stringify({ sims: "x" })), null);
    // A missing total is summed.
    assert.equal(parseSimslimTop(JSON.stringify({ sims: [{ udid: "A", memory: { bytes: 5 } }, { udid: "B", memory: { bytes: 7 } }] }))?.totalBytes, 12);
  });

  it("parses `verify --json` (VerifyResult)", () => {
    assert.deepEqual(parseSimslimVerify(fixture("verify-ok.json")), { udid: "6F1C2E9A-3B7D-4E21-9C55-0A8B1D2E3F40", ok: true, missing: [], extra: [] });
    assert.deepEqual(parseSimslimVerify(fixture("verify-drift.json")), {
      udid: "6F1C2E9A-3B7D-4E21-9C55-0A8B1D2E3F40",
      ok: false,
      missing: ["com.apple.Spotlight", "com.apple.photoanalysisd"],
      extra: ["com.apple.apsd"]
    });
    assert.equal(parseSimslimVerify("simulator must be booted to read its state"), null);
  });

  it("reads the install script's answer", () => {
    assert.deepEqual(parseSimslimInstall("simslim 0.13.0\n"), { kind: "installed", version: "0.13.0" });
    assert.deepEqual(parseSimslimInstall("downloading\nsimslim-unsupported Darwin x86_64\n"), { kind: "unsupported", reason: "Darwin x86_64" });
    assert.equal(parseSimslimInstall(""), null);
    assert.equal(isPinnedSimslim(parseSimslimInstall("simslim 0.13.0")), true);
    assert.equal(isPinnedSimslim(parseSimslimInstall("simslim 0.12.2")), false);
  });
});

describe("simslim install script", () => {
  /** Run the script with stub `uname`, `curl` and `shasum` first on PATH. */
  const run = (options: { os: string; arch: string; sum?: string; repeat?: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), "orq-simslim-"));
    try {
      const bin = join(dir, "bin");
      const tools = join(dir, "tools");
      for (const path of [bin, tools, join(dir, "pkg")]) mkdirSync(path, { recursive: true });
      // The "release": a tarball whose simslim prints the pinned version.
      writeFileSync(join(dir, "pkg", "simslim"), `#!/bin/sh\necho 'simslim ${SIMSLIM_RELEASE.version}'\n`);
      chmodSync(join(dir, "pkg", "simslim"), 0o755);
      spawnSync("tar", ["-czf", join(dir, "release.tar.gz"), "-C", join(dir, "pkg"), "simslim"]);
      const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      stub("uname", `[ "$1" = -m ] && echo ${options.arch} || echo ${options.os}`);
      stub("curl", `while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp ${JSON.stringify(join(dir, "release.tar.gz"))} "$out"; echo curl >> ${JSON.stringify(join(dir, "calls"))}`);
      stub("shasum", `echo "${options.sum ?? SIMSLIM_RELEASE.sha256}  $3"`);
      const result = spawnSync("/bin/sh", ["-c", SIMSLIM_INSTALL_SCRIPT, "simslim-install"], {
        env: { PATH: `${bin}:/usr/bin:/bin`, TOOLS: tools, TMPDIR: dir },
        encoding: "utf8"
      });
      const downloads = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).length : 0;
      const calls = downloads();
      const again = options.repeat ? spawnSync("/bin/sh", ["-c", SIMSLIM_INSTALL_SCRIPT, "simslim-install"], { env: { PATH: `${bin}:/usr/bin:/bin`, TOOLS: tools, TMPDIR: dir }, encoding: "utf8" }) : null;
      const callsAfter = downloads();
      return { result, again, calls, callsAfter };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("downloads the pinned release once, checks its SHA-256, and reports the version", () => {
    const { result, again, calls, callsAfter } = run({ os: "Darwin", arch: "arm64", repeat: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseSimslimInstall(result.stdout), { kind: "installed", version: SIMSLIM_RELEASE.version });
    assert.equal(calls, 1);
    assert.equal(again!.status, 0);
    assert.equal(callsAfter, 1, "an installed pinned binary is not downloaded again");
  });

  it("refuses a release whose checksum differs, and skips Macs it cannot run on", () => {
    const bad = run({ os: "Darwin", arch: "arm64", sum: "0".repeat(64) }).result;
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /checksum mismatch/);
    for (const [os, arch] of [["Darwin", "x86_64"], ["Linux", "arm64"]] as const) {
      const skipped = run({ os, arch }).result;
      assert.equal(skipped.status, 0);
      assert.deepEqual(parseSimslimInstall(skipped.stdout), { kind: "unsupported", reason: `${os} ${arch}` });
    }
  });


});
