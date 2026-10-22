/**
 * Changed-file kinds: what a changed path is FOR — logic, tests, test support,
 * generated output or prose — judged by its path alone.
 *
 * Shared on purpose: the UI splits a turn's or a commit's +/- by kind so a
 * reviewer can see how much of a change is logic, and the daemon can make the
 * same call over the same paths without a second rule set drifting from this
 * one. Pure string work; nothing here reads a file.
 */

/** Every kind, in display order: logic first, then what supports or describes it. */
export const CHANGED_FILE_KINDS = ["code", "tests", "mocks", "generated", "docs"] as const;

export type ChangedFileKind = (typeof CHANGED_FILE_KINDS)[number];

// Adapted from T3 Code (MIT): packages/shared/src/changedFileKind.ts
const GENERATED_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock"
]);
const GENERATED_NAME =
  /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/;
const GENERATED_DIRS = new Set(["__generated__", "generated"]);

const MOCK_NAME = /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/;
const MOCK_DIRS = new Set([
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "fakes",
  "fixture",
  "fixtures",
  "mock",
  "mocks",
  "stubs",
  "testdata"
]);

const TEST_NAME =
  /(\.(test|spec|e2e)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i;
// Case-sensitive: `FooTest.java` is a test class, `Latest.java` is not.
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/;
const TEST_DIRS = new Set(["__tests__", "__test__", "cypress", "e2e", "spec", "specs", "test", "tests"]);

const DOCS_NAME = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
// Plain-text files that tools read as config or input, not prose.
const NOT_DOCS_NAME = /^(requirements.*|constraints.*|CMakeLists|robots|llms)\.txt$/i;

/**
 * Sorts a changed file by its path alone, using common naming conventions.
 * Lockfiles and build output count as generated, test support (mocks,
 * fixtures, snapshots) is kept apart from the tests themselves, and prose
 * (Markdown, plain text) is its own kind. Everything else is code.
 */
export function classifyChangedFile(path: string): ChangedFileKind {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.pop() ?? "";
  const dirs = segments.map((segment) => segment.toLowerCase());
  const inDir = (set: ReadonlySet<string>): boolean => dirs.some((dir) => set.has(dir));
  if (GENERATED_FILES.has(name.toLowerCase()) || GENERATED_NAME.test(name) || inDir(GENERATED_DIRS)) {
    return "generated";
  }
  if (MOCK_NAME.test(name) || inDir(MOCK_DIRS)) return "mocks";
  if (TEST_NAME.test(name) || CLASS_TEST_NAME.test(name) || inDir(TEST_DIRS)) return "tests";
  if (DOCS_NAME.test(name) && !NOT_DOCS_NAME.test(name)) return "docs";
  return "code";
}

/** One kind's share of a change. */
export interface ChangedFileKindTotals {
  files: number;
  additions: number;
  deletions: number;
}

export type ChangedFileKindBreakdown = Record<ChangedFileKind, ChangedFileKindTotals>;

/**
 * A change's files and +/- per kind. Line counts are optional — a working-tree
 * status list knows paths only, and a binary file has none — and a missing
 * count adds nothing, while the file is still counted under its kind.
 */
// Adapted from T3 Code (MIT): apps/server/src/pullRequest/pullRequestChangeBreakdown.ts
export function summarizeChangedFileKinds(
  files: readonly { path: string; additions?: number | null; deletions?: number | null }[]
): ChangedFileKindBreakdown {
  const breakdown = Object.fromEntries(
    CHANGED_FILE_KINDS.map((kind) => [kind, { files: 0, additions: 0, deletions: 0 }])
  ) as ChangedFileKindBreakdown;
  for (const file of files) {
    const bucket = breakdown[classifyChangedFile(file.path)];
    bucket.files += 1;
    bucket.additions += typeof file.additions === "number" ? file.additions : 0;
    bucket.deletions += typeof file.deletions === "number" ? file.deletions : 0;
  }
  return breakdown;
}
