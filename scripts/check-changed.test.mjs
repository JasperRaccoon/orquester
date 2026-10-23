import assert from "node:assert/strict";
import { test } from "node:test";
import { packageOf, planTests, planTypecheck, runnerOf, selectTests, shellQuote } from "./check-changed.mjs";

const DAEMON_TEST =
  "TSX_DISABLE_CACHE=1 node --import tsx --import ../../scripts/test/assert-ok.mjs --import ../../scripts/test/quiet-mock-timers.mjs --test --test-concurrency=${ORQUESTER_TEST_CONCURRENCY:-4} $(find src -name '*.test.ts') && for f in $(find src -name '*.check.ts'); do node --import tsx \"$f\" || exit 1; done";
const PACKAGES = [
  { dir: "apps/daemon", name: "@orquester/daemon", testScript: DAEMON_TEST },
  { dir: "apps/web", name: "@orquester/web", testScript: "node --test $(find test -name '*.test.mjs')" },
  { dir: "packages/api", name: "@orquester/api", testScript: "TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=${ORQUESTER_TEST_CONCURRENCY:-4} $(find src -name '*.test.ts')" },
  { dir: "packages/registry", name: "@orquester/registry", testScript: undefined }
];

/** A fake tree: the set of existing repository paths. */
function tree(paths) {
  const set = new Set(paths);
  return {
    exists: (file) => set.has(file),
    readdir: (dir) => {
      const prefix = dir === "." ? "" : `${dir}/`;
      const entries = [...set].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
      if (entries.length === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    }
  };
}

test("selectTests: changed tests, and the tests and checks beside a changed file", () => {
  const fs = tree([
    "apps/daemon/src/daily-log.ts",
    "apps/daemon/src/daily-log.test.ts",
    "apps/daemon/src/daily-log.rotation.test.ts",
    "apps/daemon/src/daily-logger.test.ts",
    "apps/daemon/src/index.ts",
    "apps/daemon/src/store.ts",
    "apps/daemon/src/store.check.ts",
    "packages/api/src/x.test.ts",
    "deploy/lib/remote-update.sh",
    "deploy/lib/remote-update.test.mjs",
    "README.md"
  ]);
  assert.deepEqual(
    selectTests(["apps/daemon/src/daily-log.ts", "apps/daemon/src/store.ts", "apps/daemon/src/index.ts", "packages/api/src/x.test.ts", "deploy/lib/remote-update.sh", "README.md"], fs),
    [
      "apps/daemon/src/daily-log.rotation.test.ts",
      "apps/daemon/src/daily-log.test.ts",
      "apps/daemon/src/store.check.ts",
      "deploy/lib/remote-update.test.mjs",
      "packages/api/src/x.test.ts"
    ],
    "daily-logger.test.ts is not a sibling of daily-log.ts; index.ts and README.md have none"
  );
});

test("selectTests: a deleted test is skipped; a deleted source still selects its sibling test", () => {
  const fs = tree(["apps/daemon/src/gone.test.ts", "apps/daemon/src/other.ts"]);
  assert.deepEqual(selectTests(["apps/daemon/src/removed.test.ts", "apps/daemon/src/gone.ts", "apps/daemon/src/vanished/dir.ts"], fs), ["apps/daemon/src/gone.test.ts"]);
});

test("packageOf picks the package that contains a path, or null", () => {
  assert.equal(packageOf("apps/daemon/src/a.ts", PACKAGES)?.name, "@orquester/daemon");
  assert.equal(packageOf("apps/daemonic/a.ts", PACKAGES), null);
  assert.equal(packageOf("scripts/a.mjs", PACKAGES), null);
});

test("runnerOf takes the package's own node --test preamble", () => {
  assert.deepEqual(runnerOf(DAEMON_TEST), {
    test: "TSX_DISABLE_CACHE=1 node --import tsx --import ../../scripts/test/assert-ok.mjs --import ../../scripts/test/quiet-mock-timers.mjs --test --test-concurrency=${ORQUESTER_TEST_CONCURRENCY:-4}",
    check: "TSX_DISABLE_CACHE=1 node --import tsx --import ../../scripts/test/assert-ok.mjs --import ../../scripts/test/quiet-mock-timers.mjs"
  });
  assert.deepEqual(runnerOf("node --test $(find test -name '*.test.mjs')"), { test: "node --test", check: "node" });
  assert.equal(runnerOf("vitest run"), null);
  assert.equal(runnerOf(undefined), null);
});

test("planTests groups files per package with its runner, root last, and reports unrunnable ones", () => {
  const plan = planTests(
    ["apps/daemon/src/a.test.ts", "apps/daemon/src/b.check.ts", "deploy/lib/remote-update.test.mjs", "packages/api/src/it's.test.ts", "packages/registry/src/r.test.ts"],
    PACKAGES
  );
  assert.deepEqual(
    plan.groups.map((group) => [group.dir, group.files, group.commands]),
    [
      [
        "apps/daemon",
        ["src/a.test.ts", "src/b.check.ts"],
        [`${runnerOf(DAEMON_TEST).test} 'src/a.test.ts'`, `${runnerOf(DAEMON_TEST).check} 'src/b.check.ts'`]
      ],
      ["packages/api", ["src/it's.test.ts"], [`TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=\${ORQUESTER_TEST_CONCURRENCY:-4} 'src/it'\\''s.test.ts'`]],
      [".", ["deploy/lib/remote-update.test.mjs"], ["node --test 'deploy/lib/remote-update.test.mjs'"]]
    ]
  );
  assert.deepEqual(plan.unrunnable, ["packages/registry/src/r.test.ts"]);
});

test("planTypecheck: affected packages and dependents, all for a root input, none otherwise", () => {
  assert.equal(planTypecheck(["README.md", "deploy/lib/remote-update.sh", "apps/web/test/a.test.mjs", "packages/api/README.md"], PACKAGES), null);
  assert.deepEqual(planTypecheck(["packages/api/src/a.ts", "apps/daemon/src/b.tsx", "packages/api/package.json"], PACKAGES), {
    args: ["--filter", "...@orquester/api", "--filter", "...@orquester/daemon"]
  });
  assert.deepEqual(planTypecheck(["apps/web/tsconfig.json"], PACKAGES), { args: ["--filter", "...@orquester/web"] });
  assert.deepEqual(planTypecheck(["tsconfig.base.json"], PACKAGES), { args: ["-r"] });
  assert.deepEqual(planTypecheck(["pnpm-lock.yaml"], PACKAGES), { args: ["-r"] });
});

test("shellQuote survives quotes and spaces", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});
