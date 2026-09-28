// AccountsService's remote reads for the git trigger (ls-remote, PR/release listings) and the
// clone-at-a-ref path, driven through a fake exec and a stubbed fetch: no git process touches a
// network, no request reaches a forge.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { type AccountsExec, AccountsService } from "./accounts";
import { AccountError } from "./account-error";
import { GitRemoteError } from "./providers/types";

const SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const TAG_OBJECT = "7ada497f806e271f569e1399b5e61d17fcb77cb4";

let root: string;
let keysDir: string;
let workspace: string;
let caPath: string;

const baseAccount = {
  gitName: "Test",
  gitEmail: "test@example.invalid",
  publicKey: "ssh-ed25519 AAAA test",
  createdAt: "2026-09-28T00:00:00.000Z"
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-accounts-remote-"));
  keysDir = join(root, "keys");
  workspace = join(root, "ws");
  await mkdir(keysDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  caPath = join(keysDir, "dc.ca.pem");
  await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n");
  await writeFile(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { ...baseAccount, id: "gh", label: "gh", provider: "github", login: "octocat", keyPath: "/k/gh", token: "ghp_secret" },
        { ...baseAccount, id: "gh-ssh-only", label: "gh2", provider: "github", login: "octocat", keyPath: "/k/gh2" },
        {
          ...baseAccount,
          id: "dc",
          label: "dc",
          provider: "bitbucket-server",
          login: "jdoe",
          baseUrl: "https://bb.corp.example/bitbucket",
          caCertPath: caPath,
          sshHost: "bb.corp.example:7999",
          keyPath: "/k/dc",
          token: "dc-secret"
        },
        {
          ...baseAccount,
          id: "cloud",
          label: "cloud",
          provider: "bitbucket-cloud",
          login: "jdoe",
          email: "jdoe@example.invalid",
          keyPath: "/k/cloud",
          token: "ATATTsecret"
        }
      ]
    })
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

/** A fake exec answering from `reply` (throw → a failed git) and recording every call. */
function fakeExec(reply: (args: string[], call: Call) => string | Error = () => "") {
  const calls: Call[] = [];
  const exec: AccountsExec = async (file, args, options) => {
    const call = { file, args, ...options };
    calls.push(call);
    const out = reply(args, call);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "" };
  };
  return { exec, calls };
}

/** A git failure the way promisified execFile reports one. */
function gitFailure(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: git\n${stderr}`), { stderr, code: 128, ...extra });
}

const service = (exec: AccountsExec) =>
  new AccountsService(join(root, "accounts.json"), keysDir, { exec, refreshKnownHosts: false });

/** The command after the leading `-c key=value` pairs. */
const command = (args: string[]): string[] => {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args.slice(i);
};

const configOf = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; args[i] === "-c"; i += 2) out.push(args[i + 1]);
  return out;
};

// --- lsRemote ------------------------------------------------------------------

const LS_OUTPUT = [
  "ref: refs/heads/main\tHEAD",
  `${SHA}\tHEAD`,
  `${SHA}\trefs/heads/main`,
  `${TAG_OBJECT}\trefs/tags/v1`,
  `${SHA}\trefs/tags/v1^{}`,
  `${SHA}\trefs/pull/7/head`
].join("\n");

test("lsRemote over SSH pins the account key, BatchMode, no prompt, 30 s, no shell", async () => {
  const { exec, calls } = fakeExec(() => LS_OUTPUT);
  const result = await service(exec).lsRemote("gh", "git@github.com:octo-org/hello-world.git");
  assert.deepEqual(result, {
    heads: { main: SHA },
    tags: { v1: { sha: TAG_OBJECT, commit: SHA } },
    defaultBranch: "main"
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, "git");
  assert.deepEqual(call.args, ["ls-remote", "--symref", "--", "git@github.com:octo-org/hello-world.git"]);
  assert.equal(call.env?.GIT_TERMINAL_PROMPT, "0");
  assert.equal(
    call.env?.GIT_SSH_COMMAND,
    'ssh -i "/k/gh" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
  );
  assert.equal(call.timeout, 30_000);
  assert.ok((call.maxBuffer ?? 0) >= 16 * 1024 * 1024);
  // The token never reaches argv or env.
  assert.ok(!JSON.stringify(call.args).includes("ghp_secret"));
});

test("lsRemote over HTTPS uses the credential store and the DC CA bundle; defaultBranch:false narrows", async () => {
  const { exec, calls } = fakeExec(() => `${SHA}\trefs/heads/master\n`);
  const url = "https://bb.corp.example/bitbucket/scm/PRJ/api.git";
  const result = await service(exec).lsRemote("dc", url, { defaultBranch: false, timeoutMs: 5_000 });
  assert.deepEqual(result, { heads: { master: SHA }, tags: {} });
  const [call] = calls;
  assert.deepEqual(configOf(call.args), [
    `credential.helper=store --file=${join(keysDir, "dc.git-credentials")}`,
    `http.sslCAInfo=${caPath}`
  ]);
  assert.deepEqual(command(call.args), ["ls-remote", "--heads", "--tags", "--", url]);
  assert.equal(call.env?.GIT_SSH_COMMAND, process.env.GIT_SSH_COMMAND);
  assert.equal(call.timeout, 5_000);
  assert.ok(!JSON.stringify(call).includes("dc-secret"));
});

test("lsRemote on a Bitbucket account pins the daemon-owned known_hosts", async () => {
  const { exec, calls } = fakeExec(() => "");
  await service(exec).lsRemote("cloud", "git@ssh.bitbucket.org:acme/web-app.git");
  assert.equal(
    calls[0].env?.GIT_SSH_COMMAND,
    `ssh -i "/k/cloud" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${join(
      keysDir,
      "known_hosts"
    )}" -o BatchMode=yes`
  );
});

test("lsRemote anonymously resets every credential helper", async () => {
  const { exec, calls } = fakeExec(() => "");
  await service(exec).lsRemote(null, "https://github.com/octo-org/hello-world");
  assert.deepEqual(configOf(calls[0].args), ["credential.helper="]);
});

test("lsRemote refuses an anonymous SSH read (it would offer this host's own keys) and points at https", async () => {
  const { exec, calls } = fakeExec(() => "");
  for (const url of ["git@github.com:octo-org/hello-world.git", "ssh://git@github.com/octo-org/hello-world.git"]) {
    await assert.rejects(service(exec).lsRemote(null, url), (error: unknown) => {
      return error instanceof GitRemoteError && error.kind === "unsupported" && /https:\/\//.test(error.message);
    });
  }
  assert.equal(calls.length, 0);
});

test("lsRemote refuses unsafe URLs before running anything", async () => {
  const { exec, calls } = fakeExec();
  for (const url of ["--upload-pack=touch /tmp/x", "file:///etc", "ext::sh -c id", "https://h/o/r\nx"]) {
    await assert.rejects(service(exec).lsRemote(null, url), (error: unknown) => {
      return error instanceof GitRemoteError && error.kind === "unsupported" && error.status === 400;
    });
  }
  assert.equal(calls.length, 0);
});

test("lsRemote classifies failures: auth, not found, timeout — and redacts userinfo", async () => {
  const svc = (err: Error) => service(fakeExec(() => err).exec);
  await assert.rejects(
    svc(gitFailure("fatal: Authentication failed for 'https://u:hunter2@github.com/o/r.git/'")).lsRemote(
      null,
      "https://github.com/o/r.git"
    ),
    (error: unknown) => {
      assert.ok(error instanceof GitRemoteError);
      assert.equal(error.kind, "auth");
      assert.ok(!error.message.includes("hunter2"));
      return true;
    }
  );
  await assert.rejects(
    svc(gitFailure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).lsRemote(
      "gh",
      "git@github.com:o/r.git"
    ),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "auth"
  );
  await assert.rejects(
    svc(gitFailure("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).lsRemote(
      null,
      "https://github.com/o/r.git"
    ),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "not_found"
  );
  await assert.rejects(
    svc(gitFailure("", { killed: true, signal: "SIGTERM", code: null })).lsRemote(null, "https://github.com/o/r.git", {
      timeoutMs: 2_000
    }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "timeout" && /2 s/.test(error.message)
  );
  await assert.rejects(service(fakeExec().exec).lsRemote("nope", "https://github.com/o/r.git"), (error: unknown) => {
    return error instanceof AccountError && error.status === 404;
  });
});

// --- cloneRepo at a ref --------------------------------------------------------

test("cloneRepo without options is the New Project dialog's clone: no ceiling, git's prompting untouched", async () => {
  const { exec, calls } = fakeExec();
  await service(exec).cloneRepo("gh", "git@github.com:o/r.git", "r", workspace);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["clone", "--", "git@github.com:o/r.git", "r"]);
  assert.equal(calls[0].cwd, workspace);
  assert.equal(calls[0].env?.GIT_TERMINAL_PROMPT, process.env.GIT_TERMINAL_PROMPT);
  assert.equal(calls[0].env?.GIT_SSH_COMMAND, 'ssh -i "/k/gh" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new');
  assert.equal(calls[0].timeout, undefined);
});

test("an unattended clone (a workflow's) gets a prompt-free env and a 10 min ceiling", async () => {
  const { exec, calls } = fakeExec();
  await service(exec).cloneRepo("gh", "https://github.com/o/r.git", "r2", workspace, { unattended: true });
  assert.equal(calls[0].env?.GIT_TERMINAL_PROMPT, "0");
  assert.ok((calls[0].timeout ?? 0) > 9 * 60_000 && (calls[0].timeout ?? 0) <= 10 * 60_000);
});

test("cloneRepo at a branch or tag clones with --branch", async () => {
  const { exec, calls } = fakeExec();
  await service(exec).cloneRepo("dc", "https://bb.corp.example/bitbucket/scm/PRJ/api.git", "wf-a", workspace, {
    ref: "release/1.0"
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(command(calls[0].args), [
    "clone",
    "--branch",
    "release/1.0",
    "--",
    "https://bb.corp.example/bitbucket/scm/PRJ/api.git",
    "wf-a"
  ]);
  assert.deepEqual(configOf(calls[0].args), [
    `credential.helper=store --file=${join(keysDir, "dc.git-credentials")}`,
    `http.sslCAInfo=${caPath}`
  ]);
});

test("cloneRepo at a sha clones, then checks out detached in the clone", async () => {
  const { exec, calls } = fakeExec();
  await service(exec).cloneRepo("gh", "https://github.com/o/r.git", "wf-b", workspace, { ref: SHA, timeoutMs: 60_000 });
  assert.deepEqual(
    calls.map((call) => [command(call.args), call.cwd]),
    [
      [["clone", "--", "https://github.com/o/r.git", "wf-b"], workspace],
      [["checkout", "--detach", SHA], join(workspace, "wf-b")]
    ]
  );
  // The checkout rides the same transport config (a later fetch may need the credentials).
  assert.deepEqual(configOf(calls[1].args), configOf(calls[0].args));
  assert.ok((calls[1].timeout ?? 0) <= 60_000);
});

test("cloneRepo fetches a sha the clone did not bring, then checks out FETCH_HEAD", async () => {
  const { exec, calls } = fakeExec((args) =>
    command(args)[0] === "checkout" && command(args)[2] === SHA ? gitFailure(`fatal: reference is not a tree: ${SHA}`) : ""
  );
  await service(exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-c", workspace, { ref: SHA });
  assert.deepEqual(
    calls.map((call) => command(call.args)),
    [
      ["clone", "--", "git@github.com:o/r.git", "wf-c"],
      ["checkout", "--detach", SHA],
      ["fetch", "origin", SHA],
      ["checkout", "--detach", "FETCH_HEAD"]
    ]
  );
  assert.ok(calls.slice(1).every((call) => call.env?.GIT_SSH_COMMAND?.includes('-i "/k/gh"')));
});

test("cloneRepo removes the clone when the sha cannot be checked out", async () => {
  const dest = join(workspace, "wf-d");
  const { exec } = fakeExec((args) => {
    const cmd = command(args);
    if (cmd[0] === "clone") {
      return "";
    }
    return gitFailure(`fatal: couldn't find remote ref ${SHA}`);
  });
  await mkdir(dest, { recursive: true }); // what the real clone would have created
  await assert.rejects(
    service(exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-d", workspace, { ref: SHA }),
    (error: unknown) => error instanceof AccountError && error.status === 400 && error.message.includes(SHA)
  );
  assert.equal(existsSync(dest), false);
});

test("cloneRepo retries an abbreviated hex that names no branch as a commit", async () => {
  const short = SHA.slice(0, 10);
  const { exec, calls } = fakeExec((args) =>
    command(args).includes("--branch")
      ? gitFailure(`warning: Could not find remote branch ${short} to clone.\nfatal: Remote branch ${short} not found in upstream origin`)
      : ""
  );
  await service(exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-e", workspace, { ref: short });
  assert.deepEqual(
    calls.map((call) => command(call.args)),
    [
      ["clone", "--branch", short, "--", "git@github.com:o/r.git", "wf-e"],
      ["clone", "--", "git@github.com:o/r.git", "wf-e"],
      ["checkout", "--detach", short]
    ]
  );
});

test("cloneRepo: a missing branch name is a clone failure, a bad ref never runs, a timeout says so", async () => {
  const missing = fakeExec(() => gitFailure("fatal: Remote branch nope not found in upstream origin"));
  await assert.rejects(
    service(missing.exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-f", workspace, { ref: "nope" }),
    (error: unknown) => error instanceof AccountError && error.status === 502 && /not found in upstream/.test(error.message)
  );
  assert.equal(missing.calls.length, 1);

  const none = fakeExec();
  for (const ref of ["-b", "has space", "x".repeat(251), ""]) {
    await assert.rejects(
      service(none.exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-g", workspace, { ref }),
      (error: unknown) => error instanceof AccountError && error.status === 400
    );
  }
  assert.equal(none.calls.length, 0);

  const slow = fakeExec(() => gitFailure("", { killed: true, signal: "SIGTERM", code: null }));
  await assert.rejects(
    service(slow.exec).cloneRepo("gh", "git@github.com:o/r.git", "wf-h", workspace, { timeoutMs: 3_000 }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "timeout" && error.status === 504
  );
});

test("cloneFromInput passes the ref through", async () => {
  const { exec, calls } = fakeExec();
  const { name } = await service(exec).cloneFromInput("gh", "octo-org/hello-world", "wf-i", workspace, {
    ref: "v1.0.0"
  });
  assert.equal(name, "wf-i");
  assert.deepEqual(command(calls[0].args), [
    "clone",
    "--branch",
    "v1.0.0",
    "--",
    "git@github.com:octo-org/hello-world.git",
    "wf-i"
  ]);
});

// --- PR / release listings: provider + repo resolution ------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: string, status = 200): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(`${String(input)} auth=${(init?.headers as Record<string, string>)?.Authorization ?? "none"}`);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

test("listPullRequests resolves the account's provider and repo from any URL form", async () => {
  const urls = stubFetch("[]");
  const svc = service(fakeExec().exec);
  assert.deepEqual(await svc.listPullRequests("gh", "git@github.com:Octo-Org/Hello-World.git"), { items: [] });
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\/Octo-Org\/Hello-World\/pulls\?/);
  assert.match(urls[0], /auth=Bearer ghp_secret$/);

  stubFetch('{"values":[]}');
  await svc.listPullRequests("dc", "ssh://git@bb.corp.example:7999/PRJ/api.git");

  const anon = stubFetch("[]");
  await svc.listPullRequests(null, "https://github.com/o/r");
  assert.match(anon[0], /auth=none$/);

  // An account without a token reads anonymously.
  const tokenless = stubFetch("[]");
  await svc.listPullRequests("gh-ssh-only", "https://github.com/o/r");
  assert.match(tokenless[0], /auth=none$/);

  const cloud = stubFetch('{"values":[]}');
  await svc.listPullRequests(null, "git@ssh.bitbucket.org:acme/web-app.git");
  assert.match(cloud[0], /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/acme\/web-app\/pullrequests\?/);
});

test("listPullRequests refuses a URL the account's provider cannot parse, and anonymous unknown hosts", async () => {
  stubFetch("[]");
  const svc = service(fakeExec().exec);
  await assert.rejects(svc.listPullRequests("gh", "https://bitbucket.org/a/b"), (error: unknown) => {
    return error instanceof GitRemoteError && error.kind === "unsupported";
  });
  await assert.rejects(svc.listPullRequests(null, "https://gitlab.com/a/b"), (error: unknown) => {
    return error instanceof GitRemoteError && error.kind === "unsupported";
  });
  await assert.rejects(svc.listPullRequests(null, "a/b"), (error: unknown) => error instanceof GitRemoteError);
});

test("listReleases: GitHub lists, Bitbucket answers unsupported without a request", async () => {
  const urls = stubFetch("[]");
  const svc = service(fakeExec().exec);
  assert.deepEqual(await svc.listReleases("gh", "https://github.com/o/r.git"), { items: [] });
  assert.match(urls[0], /\/repos\/o\/r\/releases\?per_page=50/);
  assert.deepEqual(await svc.listReleases("cloud", "https://bitbucket.org/acme/web-app"), {
    items: [],
    unsupported: true
  });
  assert.equal(urls.length, 1);
});

test("cloneRepo resolves an abbreviated commit (Bitbucket Cloud's 12 hex) against the remote's refs before fetching it", async () => {
  const short = SHA.slice(0, 12);
  const other = "f".repeat(40);
  const { exec, calls } = fakeExec((args) => {
    const cmd = command(args);
    if (cmd.includes("--branch")) return gitFailure(`fatal: Remote branch ${short} not found in upstream origin`);
    if (cmd[0] === "checkout" && cmd[2] === short) return gitFailure(`error: pathspec '${short}' did not match any file(s) known to git`);
    if (cmd[0] === "ls-remote") return `${other}\trefs/heads/main\n${SHA}\trefs/pull-requests/7/from\n`;
    return "";
  });
  await service(exec).cloneRepo("cloud", "git@ssh.bitbucket.org:acme/web-app.git", "wf-f", workspace, { ref: short, unattended: true });
  assert.deepEqual(
    calls.map((call) => command(call.args)).slice(2),
    [
      ["checkout", "--detach", short],
      ["ls-remote", "origin"],
      ["fetch", "origin", SHA],
      ["checkout", "--detach", "FETCH_HEAD"]
    ]
  );
});

test("an abbreviated commit no ref resolves fails clearly and removes the clone (never fetches a prefix)", async () => {
  const short = SHA.slice(0, 12);
  const dest = join(workspace, "wf-g");
  const { exec, calls } = fakeExec((args) => {
    const cmd = command(args);
    if (cmd.includes("--branch")) return gitFailure(`fatal: Remote branch ${short} not found in upstream origin`);
    if (cmd[0] === "checkout") return gitFailure("error: pathspec did not match");
    if (cmd[0] === "ls-remote") return `${"f".repeat(40)}\trefs/heads/main\n`;
    return "";
  });
  await mkdir(dest, { recursive: true });
  await assert.rejects(
    service(exec).cloneRepo("cloud", "git@ssh.bitbucket.org:acme/web-app.git", "wf-g", workspace, { ref: short }),
    (error: unknown) => error instanceof AccountError && error.status === 400 && /abbreviated commit id/.test(error.message)
  );
  assert.ok(!calls.some((call) => command(call.args)[0] === "fetch"));
  assert.equal(existsSync(dest), false);
});
