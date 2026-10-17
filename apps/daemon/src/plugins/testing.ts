// Test support for the plugin tests: engine platform tarballs built on the spot
// in the real layouts (tsc-rs: `package/lib/tsc` beside its lib .d.ts files;
// tsrs: `package/tsrs` beside them), with a shell script for the binary, and
// in-memory npm registries serving them. Nothing here touches the network.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TsCheckerEngine } from "@orquester/api";
import {
  NPM_REGISTRY,
  TS_CHECKER_ENGINE_SPECS,
  type TsCheckerEngineSpec,
  type TsRustInstallerDeps,
  runVersionCommand
} from "./ts-rust/installer.ts";

const exec = promisify(execFile);

/** The platform package each engine's fake registry serves: this host's on linux-x64 glibc. */
export const FIXTURE_PLATFORM_PACKAGES: Readonly<Record<TsCheckerEngine, string>> = {
  "tsc-rs": "@tsc-rs/linux-x64",
  tsrs: "@tsrs/linux-x64-gnu"
};

export interface FixtureTarball {
  tgz: string;
  /** `sha512-<base64>` of the tarball, as the registry's `dist.integrity`. */
  integrity: string;
}

export interface FixtureOptions {
  /** The binary's script body; default prints `Version 7.1.0-dev (<engine> <version>)` and exits 0. */
  script?: string;
  /** Leave the binary out of the package. */
  noBinary?: boolean;
}

/** A platform tarball of `engine` (tsc-rs by default) for `version`, built under `dir`. */
export async function makeTsRustTarball(
  dir: string,
  version: string,
  options: FixtureOptions = {},
  engine: TsCheckerEngineSpec = TS_CHECKER_ENGINE_SPECS["tsc-rs"]
): Promise<FixtureTarball> {
  const src = await mkdtemp(join(dir, `src-${engine.id}-${version}-`));
  const binDir = join(src, ...engine.packageDir.split("/"));
  await mkdir(binDir, { recursive: true });
  await writeFile(join(src, "package", "package.json"), JSON.stringify({ name: `fixture-${engine.id}`, version }));
  await writeFile(join(binDir, "lib.d.ts"), `// lib for ${version}\n`);
  if (engine.packageDir === "package") {
    await writeFile(join(src, "package", "LICENSE"), "MIT\n");
  }
  if (!options.noBinary) {
    const script = options.script ?? `#!/bin/sh\necho "Version 7.1.0-dev (${engine.id} ${version})"\n`;
    // Shipped without the exec bit: the installer must chmod it.
    await writeFile(join(binDir, engine.binaryName("linux")), script, { mode: 0o644 });
  }
  const tgz = join(dir, `${engine.id}-${version}-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  await exec("tar", ["-czf", tgz, "-C", src, "package"]);
  const integrity = `sha512-${createHash("sha512").update(await readFile(tgz)).digest("base64")}`;
  return { tgz, integrity };
}

export interface FakeRegistry {
  engine: TsCheckerEngineSpec;
  /** The one platform package it serves. */
  platformPackage: string;
  deps: TsRustInstallerDeps;
  /** The version `<mainPackage>/latest` answers. */
  latest: string;
  /** Platform tarballs by version; `integrity` overrides what the registry claims. */
  releases: Map<string, FixtureTarball & { claimedIntegrity?: string }>;
  calls: { latest: number; meta: string[]; tarballs: string[] };
  /** Set to make every registry request fail with this message. */
  failWith: string | null;
}

/**
 * An npm registry over `releases` of one engine (tsc-rs by default) and one
 * platform package (its {@link FIXTURE_PLATFORM_PACKAGES} one by default),
 * with the real smoke-test runner and a fixed clock. Any other package is a 404.
 */
export function fakeRegistry(
  now = "2026-10-14T12:00:00.000Z",
  engine: TsCheckerEngineSpec = TS_CHECKER_ENGINE_SPECS["tsc-rs"],
  platformPackage: string = FIXTURE_PLATFORM_PACKAGES[engine.id]
): FakeRegistry {
  const base = platformPackage.slice(platformPackage.indexOf("/") + 1);
  const tarballPrefix = `https://registry.npmjs.org/${platformPackage}/-/${base}-`;
  const registry: FakeRegistry = {
    engine,
    platformPackage,
    latest: "0.0.0",
    releases: new Map(),
    calls: { latest: 0, meta: [], tarballs: [] },
    failWith: null,
    deps: {
      fetchJson: async (url) => {
        if (registry.failWith) throw new Error(registry.failWith);
        if (url === `${NPM_REGISTRY}/${engine.mainPackage}/latest`) {
          registry.calls.latest += 1;
          return { name: engine.mainPackage, version: registry.latest };
        }
        const prefix = `${NPM_REGISTRY}/${platformPackage.replace("/", "%2f")}/`;
        if (!url.startsWith(prefix)) throw new Error(`HTTP 404 from ${url}`);
        const version = decodeURIComponent(url.slice(prefix.length));
        registry.calls.meta.push(version);
        const release = registry.releases.get(version);
        if (!release) throw new Error(`HTTP 404 from ${url}`);
        return {
          name: platformPackage,
          version,
          dist: {
            tarball: `${tarballPrefix}${version}.tgz`,
            integrity: release.claimedIntegrity ?? release.integrity
          }
        };
      },
      fetchTarball: async (url, dest) => {
        registry.calls.tarballs.push(url);
        const version = url.startsWith(tarballPrefix) ? url.slice(tarballPrefix.length, -".tgz".length) : undefined;
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

/**
 * One installer deps over several engines' registries: each request goes to
 * the registry of the package it names, through that registry's `deps` as
 * they are at call time (so a test may swap one registry's functions).
 */
export function combinedRegistryDeps(registries: readonly FakeRegistry[]): TsRustInstallerDeps {
  const pick = (url: string): FakeRegistry => {
    const found = registries.find(
      (registry) =>
        url.startsWith(`${NPM_REGISTRY}/${registry.engine.mainPackage}/`) ||
        url.includes(`${registry.platformPackage}/`) ||
        url.includes(`${registry.platformPackage.replace("/", "%2f")}/`)
    );
    if (!found) throw new Error(`HTTP 404 from ${url}`);
    return found;
  };
  const first = registries[0];
  if (!first) throw new Error("no registries");
  return {
    fetchJson: (url, signal) => pick(url).deps.fetchJson(url, signal),
    fetchTarball: (url, dest, signal) => pick(url).deps.fetchTarball(url, dest, signal),
    runSmokeTest: (binary, options) => first.deps.runSmokeTest(binary, options),
    now: () => first.deps.now()
  };
}

/** Build a release fixture of the registry's engine under `dir` and publish it in `registry`. */
export async function publish(
  registry: FakeRegistry,
  dir: string,
  version: string,
  options: FixtureOptions & { claimedIntegrity?: string } = {}
): Promise<void> {
  const tarball = await makeTsRustTarball(dir, version, options, registry.engine);
  registry.releases.set(version, { ...tarball, claimedIntegrity: options.claimedIntegrity });
}

export async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
