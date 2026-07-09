import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RegistryService, parseEnvFile } from "./registry.ts";

test("parseEnvFile handles common dotenv syntax", () => {
  assert.deepEqual(
    parseEnvFile(`
# comment
HTTPS_PROXY=http://proxy.example:8080
HTTP_PROXY='http://proxy.example:8080'
export NO_PROXY="localhost,127.0.0.1,::1"
bad-key=ignored
NO_VALUE
`),
    {
      HTTPS_PROXY: "http://proxy.example:8080",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost,127.0.0.1,::1"
    }
  );
});

test("RegistryService applies per-launcher env files without exposing them in registry responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "orquester-registry-env-"));
  try {
    await mkdir(join(root, "env"));
    await writeFile(
      join(root, "agents.json"),
      JSON.stringify([
        {
          id: "opencode",
          name: "OpenCode",
          kind: "agent",
          bin: [process.execPath]
        }
      ])
    );
    await writeFile(
      join(root, "env", "opencode.env"),
      [
        "HTTPS_PROXY=http://proxy.example:8080",
        "HTTP_PROXY=http://proxy.example:8080",
        "NO_PROXY=localhost,127.0.0.1,::1"
      ].join("\n")
    );

    const registry = new RegistryService(root);
    await registry.init();

    const internal = registry.get("opencode");
    assert.equal(internal?.env?.HTTPS_PROXY, "http://proxy.example:8080");
    assert.equal(internal?.env?.NO_PROXY, "localhost,127.0.0.1,::1");

    const listed = registry.list().agents.find((entry) => entry.id === "opencode");
    assert.equal(listed?.enabled, true);
    assert.equal(listed?.env, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
