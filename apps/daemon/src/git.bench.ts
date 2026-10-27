/**
 * Reproducible GitService.status timings, using disposable real repositories.
 * Run from apps/daemon:
 *   TSX_DISABLE_CACHE=1 node --import tsx src/git.bench.ts
 * To compare an older git.ts copied beside this file, set GIT_BENCH_MODULE to
 * its relative module path (for example ./git.baseline.ts).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { GitService as GitServiceType } from "./git";

const exec = promisify(execFile);
const { GitService } = await import(process.env.GIT_BENCH_MODULE ?? "./git.ts") as { GitService: typeof GitServiceType };
const root = await mkdtemp(join(tmpdir(), "orq-git-bench-"));
const samples = 15;
const batch = 10;
const warmup = 10;

try {
  for (const fileCount of [100, 2000]) {
    const repo = join(root, `repo-${fileCount}`);
    await mkdir(repo);
    const git = (...args: string[]) => exec("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
    });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "bench@example.invalid");
    await git("config", "user.name", "Benchmark");
    await git("config", "commit.gpgsign", "false");
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(repo, `file-${index}.txt`), `line ${index}\n`)));
    await git("add", "-A");
    await git("commit", "-qm", "fixture");
    await writeFile(join(repo, "file-0.txt"), "changed\n");
    await writeFile(join(repo, "untracked.txt"), "new\n");

    let subprocesses = 0;
    const service = new GitService({ runner: async (file, args, options) => {
      subprocesses += 1;
      return exec(file, args, {
        ...options,
        env: { ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
      });
    } });
    const expected = await service.status(repo);
    assert.equal(expected.isRepo, true);
    assert.equal(expected.branch, "main");
    assert.deepEqual(expected.files.map((file) => [file.path, file.status]), [
      ["file-0.txt", "modified"], ["untracked.txt", "untracked"]
    ]);
    for (let index = 0; index < warmup; index += 1) assert.deepEqual(await service.status(repo), expected);

    subprocesses = 0;
    const durations: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const start = performance.now();
      for (let index = 0; index < batch; index += 1) assert.deepEqual(await service.status(repo), expected);
      durations.push((performance.now() - start) / batch);
    }
    durations.sort((a, b) => a - b);
    console.log(JSON.stringify({
      scenario: `dirty-${fileCount}-files`, samples, calls: samples * batch,
      medianMs: Number(durations[Math.floor(samples / 2)].toFixed(3)),
      p95BatchMeanMs: Number(durations[Math.ceil(samples * 0.95) - 1].toFixed(3)),
      subprocessesPerCall: subprocesses / (samples * batch),
      output: expected
    }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
