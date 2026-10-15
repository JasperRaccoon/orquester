// Test support for the plugin tests: tsc-rs platform tarballs built on the spot
// (the real layout, `package/lib/tsc` beside its lib .d.ts files, with a shell
// script for the binary) and an in-memory npm registry serving them. Nothing
// here touches the network.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NPM_REGISTRY, type TsRustInstallerDeps, runVersionCommand } from "./ts-rust/installer.ts";

const exec = promisify(execFile);

export interface FixtureTarball {
  tgz: string;
  /** `sha512-<base64>` of the tarball, as the registry's `dist.integrity`. */
  integrity: string;
}

export interface FixtureOptions {
  /** The `tsc` script body; default prints `Version <version>` and exits 0. */
  script?: string;
  /** Leave `lib/tsc` out of the package. */
  noBinary?: boolean;
}

/** A platform tarball for `version`, built under `dir`. */
export async function makeTsRustTarball(dir: string, version: string, options: FixtureOptions = {}): Promise<FixtureTarball> {
  const src = await mkdtemp(join(dir, `src-${version}-`));
  const lib = join(src, "package", "lib");
  await mkdir(lib, { recursive: true });
  await writeFile(join(src, "package", "package.json"), JSON.stringify({ name: "@tsc-rs/linux-x64", version }));
  await writeFile(join(lib, "lib.d.ts"), `// lib for ${version}\n`);
  if (!options.noBinary) {
    const script = options.script ?? `#!/bin/sh\necho "Version 7.1.0-dev (tsc-rs ${version})"\n`;
    // Shipped without the exec bit: the installer must chmod it.
    await writeFile(join(lib, "tsc"), script, { mode: 0o644 });
  }
  const tgz = join(dir, `tsc-rs-${version}-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  await exec("tar", ["-czf", tgz, "-C", src, "package"]);
  const integrity = `sha512-${createHash("sha512").update(await readFile(tgz)).digest("base64")}`;
  return { tgz, integrity };
}

export interface FakeRegistry {
  deps: TsRustInstallerDeps;
  /** The version `tsc-rs/latest` answers. */
  latest: string;
  /** Platform tarballs by version; `integrity` overrides what the registry claims. */
  releases: Map<string, FixtureTarball & { claimedIntegrity?: string }>;
  calls: { latest: number; meta: string[]; tarballs: string[] };
  /** Set to make every registry request fail with this message. */
  failWith: string | null;
}

/** An npm registry over `releases`, with the real smoke-test runner and a fixed clock. */
export function fakeRegistry(now = "2026-10-14T12:00:00.000Z"): FakeRegistry {
  const registry: FakeRegistry = {
    latest: "0.0.0",
    releases: new Map(),
    calls: { latest: 0, meta: [], tarballs: [] },
    failWith: null,
    deps: {
      fetchJson: async (url) => {
        if (registry.failWith) throw new Error(registry.failWith);
        if (url === `${NPM_REGISTRY}/tsc-rs/latest`) {
          registry.calls.latest += 1;
          return { name: "tsc-rs", version: registry.latest };
        }
        const prefix = `${NPM_REGISTRY}/@tsc-rs%2flinux-x64/`;
        if (!url.startsWith(prefix)) throw new Error(`HTTP 404 from ${url}`);
        const version = decodeURIComponent(url.slice(prefix.length));
        registry.calls.meta.push(version);
        const release = registry.releases.get(version);
        if (!release) throw new Error(`HTTP 404 from ${url}`);
        return {
          name: "@tsc-rs/linux-x64",
          version,
          dist: {
            tarball: `https://registry.npmjs.org/@tsc-rs/linux-x64/-/linux-x64-${version}.tgz`,
            integrity: release.claimedIntegrity ?? release.integrity
          }
        };
      },
      fetchTarball: async (url, dest) => {
        registry.calls.tarballs.push(url);
        const version = /linux-x64-(.+)\.tgz$/.exec(url)?.[1];
        const release = version ? registry.releases.get(version) : undefined;
        if (!release) throw new Error(`HTTP 404 from ${url}`);
        await copyFile(release.tgz, dest);
      },
      runSmokeTest: runVersionCommand,
      now: () => new Date(now)
    }
  };
  return registry;
}

/** Build a release fixture under `dir` and publish it in `registry`. */
export async function publish(
  registry: FakeRegistry,
  dir: string,
  version: string,
  options: FixtureOptions & { claimedIntegrity?: string } = {}
): Promise<void> {
  const tarball = await makeTsRustTarball(dir, version, options);
  registry.releases.set(version, { ...tarball, claimedIntegrity: options.claimedIntegrity });
}

export async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
