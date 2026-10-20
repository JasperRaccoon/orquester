import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyToolingContributions,
  boxToolVersionDir,
  boxToolingArchivePath,
  boxToolingPluginDir,
  toolingEnvKey,
  toolingJoinPath
} from "./index.ts";

/**
 * Node's NODE_OPTIONS tokenizer (`ParseNodeOptionsEnvVar`, src/node_options.cc),
 * reimplemented: spaces outside double quotes split arguments, a `"` toggles
 * quoting and is dropped, and inside quotes a backslash makes the next
 * character literal. A backslash outside quotes is an ordinary character.
 */
function parseNodeOptions(value: string): string[] {
  const args: string[] = [];
  let inString = false;
  let startNew = true;
  for (let index = 0; index < value.length; index += 1) {
    let c = value[index] as string;
    if (c === "\\" && inString) {
      if (index + 1 === value.length) throw new Error("invalid value for NODE_OPTIONS (invalid escape)");
      index += 1;
      c = value[index] as string;
    } else if (c === " " && !inString) {
      startNew = true;
      continue;
    } else if (c === '"') {
      inString = !inString;
      continue;
    }
    if (startNew) {
      args.push(c);
      startNew = false;
    } else {
      args[args.length - 1] += c;
    }
  }
  if (inString) throw new Error("invalid value for NODE_OPTIONS (unterminated string)");
  return args;
}

const none = { pathPrepend: [], env: {}, nodeRequire: [] };

test("box tooling paths follow the target's separators", () => {
  assert.equal(boxToolVersionDir("linux", "/var/lib/orq-agent", "tsrs", "0.16.0"), "/var/lib/orq-agent/tooling/tsrs/versions/0.16.0");
  assert.equal(boxToolVersionDir("win32", "C:\\orq\\agent", "tsc-rs", "0.7.0"), "C:\\orq\\agent\\tooling\\tsc-rs\\versions\\0.7.0");
  assert.equal(boxToolingPluginDir("darwin", "/Users/me/.orq-agent/", "ts-rust"), "/Users/me/.orq-agent/tooling/ts-rust");
  assert.equal(toolingJoinPath("win32", "C:\\", "orq", "a/b"), "C:\\orq\\a\\b");
  assert.equal(toolingJoinPath("linux", "/", "tmp"), "/tmp");
  assert.equal(
    boxToolingArchivePath("/base", { tool: "tsrs", version: "0.16.0", os: "linux", arch: "arm64", libc: "musl" }),
    "/base/daemon/boxes/tooling-cache/tsrs/0.16.0/linux-arm64-musl.tgz"
  );
  assert.equal(
    boxToolingArchivePath("/base", { tool: "tsc-rs", version: "0.7.0", os: "win32", arch: "x64", libc: null }),
    "/base/daemon/boxes/tooling-cache/tsc-rs/0.7.0/win32-x64.tgz"
  );
});

test("a Windows preload path survives Node's NODE_OPTIONS tokenizer, backslashes, spaces and quotes included", () => {
  const files = [
    "C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs",
    "C:\\Program Files\\orq\\preload.cjs",
    'C:\\odd "quoted" dir\\preload.cjs',
    "C:\\trailing\\"
  ];
  for (const file of files) {
    const env = applyToolingContributions({ Path: "C:\\Windows" }, [{ ...none, nodeRequire: [file] }], "win32");
    assert.deepEqual(parseNodeOptions(env.NODE_OPTIONS ?? ""), ["--require", file]);
  }
  const existing = applyToolingContributions(
    { Node_Options: "--max-old-space-size=4096 --title \"a b\"" },
    [{ ...none, nodeRequire: [files[0] as string] }],
    "win32"
  );
  assert.deepEqual(Object.keys(existing), ["Node_Options"], "the existing spelling is kept on Windows");
  assert.deepEqual(parseNodeOptions(existing.Node_Options ?? ""), ["--max-old-space-size=4096", "--title", "a b", "--require", files[0]]);
});

test("Node itself reads the quoting: a --require file whose name has backslashes and spaces loads", { skip: process.platform === "win32" ? "POSIX file names" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-tooling-node-options-"));
  try {
    // On POSIX a backslash is an ordinary file-name character, so this is the
    // Windows path's escaping exercised by the real parser.
    const file = join(dir, "C:\\orq dir\\preload.cjs");
    await writeFile(file, 'process.stdout.write("preloaded\\n");\n');
    const env = applyToolingContributions({ PATH: process.env.PATH ?? "" }, [{ ...none, nodeRequire: [file] }], "linux");
    const result = spawnSync(process.execPath, ["-e", 'process.stdout.write("main\\n")'], { env, encoding: "utf8" });
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "preloaded\nmain\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PATH: prepended with the target's delimiter; Windows merges every spelling into the one present", () => {
  const posix = applyToolingContributions({ PATH: "/usr/bin:/bin" }, [{ ...none, pathPrepend: ["/opt/a", "/opt/b"] }], "linux");
  assert.equal(posix.PATH, "/opt/a:/opt/b:/usr/bin:/bin");

  const windows = applyToolingContributions(
    { Path: "C:\\Windows;C:\\Windows\\System32", PATH: "C:\\tools;c:\\windows" },
    [{ ...none, pathPrepend: ["C:\\orq\\agent\\tooling\\x\\bin"] }],
    "win32"
  );
  assert.deepEqual(Object.keys(windows), ["Path"]);
  assert.equal(windows.Path, "C:\\orq\\agent\\tooling\\x\\bin;C:\\Windows;C:\\Windows\\System32;C:\\tools");

  // On POSIX `Path` is just another variable.
  const posixCase = applyToolingContributions({ PATH: "/bin", Path: "x" }, [{ ...none, pathPrepend: ["/opt"] }], "darwin");
  assert.deepEqual(posixCase, { PATH: "/opt:/bin", Path: "x" });

  assert.throws(() => applyToolingContributions({}, [{ ...none, pathPrepend: ["/opt"] }], "linux"), /no PATH/);
});

test("env vars land under the existing spelling on Windows; the input env is never changed", () => {
  const input = { Path: "C:\\Windows", tsrs_home: "old" };
  const out = applyToolingContributions(input, [{ ...none, env: { TSRS_HOME: "C:\\x", OTHER: "1" } }], "win32");
  assert.deepEqual(out, { Path: "C:\\Windows", tsrs_home: "C:\\x", OTHER: "1" });
  assert.deepEqual(input, { Path: "C:\\Windows", tsrs_home: "old" });
  assert.equal(toolingEnvKey({ path: "x" }, "PATH", "win32"), "path");
  assert.equal(toolingEnvKey({}, "PATH", "win32", "Path"), "Path");
  assert.equal(toolingEnvKey({ path: "x" }, "PATH", "linux"), "PATH");
});

test("no contribution leaves the env as it is; requiring the same file twice adds it once", () => {
  assert.deepEqual(applyToolingContributions({ PATH: "/bin" }, [], "linux"), { PATH: "/bin" });
  const twice = applyToolingContributions({}, [{ ...none, nodeRequire: ["/a.cjs"] }, { ...none, nodeRequire: ["/a.cjs"] }], "linux");
  assert.equal(twice.NODE_OPTIONS, '--require "/a.cjs"');
});
