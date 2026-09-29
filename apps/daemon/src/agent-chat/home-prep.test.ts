import { strict as assert } from "node:assert";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markClaudeProjectTrusted } from "./home-prep.ts";

// Claude project trust: a reality finding (SEAMS §2) whose write lands on the
// user's own credential-bearing `~/.claude.json`, so the *how* matters as much
// as the *what*.

test("a malformed projects map is replaced rather than crashing the launch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, ".claude.json");
  await writeFile(file, JSON.stringify({ projects: "nonsense" }));
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), true);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual((written.projects as Record<string, unknown>)["/w/p"], {
    hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true
  });
});

test("markClaudeProjectTrusted writes 0600 and survives an absent file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  const file = join(dir, ".claude.json");
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), true);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(written.hasCompletedOnboarding, true);
  assert.deepEqual((written.projects as Record<string, unknown>)["/w/p"], {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true
  });
  // Explicitly asserted, not assumed: `{mode}` on writeFile is inert for an
  // existing file, which is why the write forces the mode itself.
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Second call changes nothing.
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), false);
  await rm(dir, { recursive: true, force: true });
});

test("a pre-existing 0644 config is NARROWED to 0600, never left wide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  const file = join(dir, ".claude.json");
  await writeFile(file, JSON.stringify({
    oauthAccount: { id: "x" },
    projects: {
      "/w/p": { allowedTools: ["Bash"], hasTrustDialogAccepted: false },
      "/other": { hasTrustDialogAccepted: true },
      "/third": { history: [1, 2] }
    }
  }), { mode: 0o644 });
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), true);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(written.oauthAccount, { id: "x" }, "the credential block survives");
  const projects = written.projects as Record<string, Record<string, unknown>>;
  assert.deepEqual(projects["/w/p"].allowedTools, ["Bash"]);
  assert.equal(projects["/w/p"].hasTrustDialogAccepted, true);
  assert.equal(projects["/other"].hasTrustDialogAccepted, true);
  assert.deepEqual(projects["/third"].history, [1, 2]);
  await rm(dir, { recursive: true, force: true });
});

test("a symlinked config is written THROUGH, never replaced by a regular file", async () => {
  // Users symlink agent configs into dotfiles repos; renaming onto the link
  // path would silently sever the setup.
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  const real = join(dir, "real.json");
  const link = join(dir, ".claude.json");
  await writeFile(real, JSON.stringify({ keep: true }), { mode: 0o600 });
  await symlink(real, link);
  assert.equal(await markClaudeProjectTrusted(link, "/w/p"), true);
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the link survives the write");
  const written = JSON.parse(await readFile(real, "utf8")) as Record<string, unknown>;
  assert.equal(written.keep, true);
  assert.equal(
    (written.projects as Record<string, Record<string, unknown>>)["/w/p"].hasTrustDialogAccepted,
    true
  );
  await rm(dir, { recursive: true, force: true });
});

test("an unwritable config never fails a launch", async () => {
  const warnings: unknown[] = [];
  // A directory where a file is expected: the write throws, the launch does not.
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  assert.equal(
    await markClaudeProjectTrusted(dir, "/w/p", { warn: (...a) => warnings.push(a) }),
    false
  );
  assert.equal(warnings.length, 1);
  await rm(dir, { recursive: true, force: true });
});
