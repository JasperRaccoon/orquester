import assert from "node:assert/strict";
import test from "node:test";
import { GitService } from "./git";

type Deferred = {
  promise: Promise<{ stdout: string; stderr: string }>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ stdout: string; stderr: string }>((done, fail) => {
    resolve = () => done({ stdout: "", stderr: "" });
    reject = fail;
  });
  return { promise, resolve, reject };
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("serializes concurrent git mutations in the same repository", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, args, options) => {
      calls.push(`${options.cwd}:${args.join(" ")}`);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo");
  await nextTurn();
  const second = git.fetch("/repo");
  await nextTurn();

  assert.deepEqual(calls, ["/repo:fetch --all --prune"]);

  commands[0].resolve();
  await first;
  await nextTurn();
  assert.deepEqual(calls, [
    "/repo:fetch --all --prune",
    "/repo:fetch --all --prune"
  ]);

  commands[1].resolve();
  await second;
});

test("allows git mutations in different repositories to run concurrently", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, _args, options) => {
      calls.push(options.cwd);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo-a");
  const second = git.fetch("/repo-b");
  await nextTurn();

  assert.deepEqual(calls, ["/repo-a", "/repo-b"]);

  commands[0].resolve();
  commands[1].resolve();
  await Promise.all([first, second]);
});

test("continues a repository queue after an earlier mutation fails", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, _args, options) => {
      calls.push(options.cwd);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo");
  await nextTurn();
  const second = git.fetch("/repo");
  await nextTurn();

  commands[0].reject(Object.assign(new Error("fetch failed"), { stderr: "fetch failed" }));
  await assert.rejects(first, /fetch failed/);
  await nextTurn();
  assert.deepEqual(calls, ["/repo", "/repo"]);

  commands[1].resolve();
  await second;
});

test("pull fetches all remotes before merging the upstream branch", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, args) => {
      calls.push(args.join(" "));
      return commands[calls.length - 1].promise;
    }
  });

  const pull = git.pull("/repo");
  await nextTurn();
  assert.deepEqual(calls, ["fetch --all --prune"]);

  commands[0].resolve();
  await nextTurn();
  assert.deepEqual(calls, ["fetch --all --prune", "merge --no-edit @{upstream}"]);

  commands[1].resolve();
  await pull;
});
