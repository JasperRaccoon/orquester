import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKnownHosts, KNOWN_HOSTS_SEED, parseKnownHostsDocument } from "./known-hosts";

test("seeds once, idempotently, preserving TOFU-appended entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-kh-"));
  const path = await ensureKnownHosts(dir, { refresh: false });
  await ensureKnownHosts(dir, { refresh: false }); // second call must not duplicate
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, "[bb.corp.com]:7999 ssh-ed25519 AAAAtofu\n");
  await ensureKnownHosts(dir, { refresh: false }); // must keep the TOFU line
  const text = await readFile(path, "utf8");
  for (const line of KNOWN_HOSTS_SEED)
    assert.equal(text.split("\n").filter((l) => l === line).length, 1);
  assert.ok(text.includes("[bb.corp.com]:7999 ssh-ed25519 AAAAtofu"));
});

test("every pinned line covers BOTH bitbucket.org and ssh.bitbucket.org", () => {
  // All Cloud SSH traffic targets ssh.bitbucket.org; known_hosts matches on the
  // hostname ssh connects to, so a bitbucket.org-only pin would never apply.
  assert.ok(KNOWN_HOSTS_SEED.length > 0);
  for (const line of KNOWN_HOSTS_SEED) {
    const hosts = line.split(" ")[0].split(",");
    assert.ok(hosts.includes("bitbucket.org"), `missing bitbucket.org in: ${line}`);
    assert.ok(hosts.includes("ssh.bitbucket.org"), `missing ssh.bitbucket.org in: ${line}`);
  }
});

test("parseKnownHostsDocument keeps only well-formed bitbucket lines, normalized + deduped", () => {
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO";
  const doc = [
    "# Bitbucket host keys",
    `bitbucket.org ssh-ed25519 ${key}`,
    `ssh.bitbucket.org ssh-ed25519 ${key}`, // same key, other host → one entry
    `evil.example.com ssh-ed25519 ${key}`, // foreign host → dropped
    "bitbucket.org totally-not-a-key-type AAAAB3Nza",
    "bitbucket.org ssh-rsa short",
    "<html>garbage</html>",
    ""
  ].join("\n");
  assert.deepEqual(parseKnownHostsDocument(doc), [
    `bitbucket.org,ssh.bitbucket.org ssh-ed25519 ${key}`
  ]);
});
