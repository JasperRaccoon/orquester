import assert from "node:assert/strict";
import { test } from "node:test";

import { BOX_KINDS, BOX_PROVIDER_IDS } from "@orquester/api";

import { VM_PROVIDER_ADAPTERS } from "./vm-providers.ts";

const VM_IDS = BOX_PROVIDER_IDS.slice(0, BOX_PROVIDER_IDS.indexOf("upcloud") + 1);

test("VM_PROVIDER_ADAPTERS: one adapter per VM provider, in catalog order", () => {
  assert.deepEqual(
    VM_PROVIDER_ADAPTERS.map((adapter) => adapter.id),
    VM_IDS
  );
});

test("VM_PROVIDER_ADAPTERS: every adapter describes itself completely", () => {
  for (const adapter of VM_PROVIDER_ADAPTERS) {
    assert.ok(adapter.label.length > 0, `${adapter.id} label`);
    assert.ok(adapter.kinds.includes("linux"), `${adapter.id} rents Linux`);
    for (const kind of adapter.kinds) assert.ok(BOX_KINDS.includes(kind), `${adapter.id} kind ${kind}`);
    assert.equal(adapter.kinds.includes("macos"), false, `${adapter.id} has no macOS`);
    assert.match(adapter.website, /^https:\/\//, `${adapter.id} website`);
    assert.match(adapter.credentialsUrl, /^https:\/\//, `${adapter.id} credentialsUrl`);
    assert.ok(adapter.credentialFields.length > 0, `${adapter.id} credential fields`);
    assert.ok(
      adapter.credentialFields.some((field) => field.secret),
      `${adapter.id} has a secret field`
    );
    const ids = adapter.credentialFields.map((field) => field.id);
    assert.equal(new Set(ids).size, ids.length, `${adapter.id} credential field ids are unique`);
    if (adapter.needsWindowsImage) {
      assert.ok(adapter.kinds.some((kind) => kind.startsWith("windows")), `${adapter.id} needs a Windows image only with Windows kinds`);
      assert.equal(typeof adapter.prepareWindowsImage, "function", `${adapter.id} prepares its Windows image`);
    }
  }
});

test("VM_PROVIDER_ADAPTERS: the kinds of spec §11.1", () => {
  const byId = new Map(VM_PROVIDER_ADAPTERS.map((adapter) => [adapter.id, new Set(adapter.kinds)]));
  // Scaleway and UpCloud Windows images have no unattended first-boot path (see their adapters).
  for (const id of ["vultr", "exoscale", "oracle", "ovh"] as const) {
    assert.ok(byId.get(id)?.has("windows"), `${id} rents Windows`);
  }
  for (const id of ["digitalocean", "ovh", "scaleway", "linode"] as const) {
    assert.ok(byId.get(id)?.has("linux-gpu"), `${id} rents Linux + GPU`);
  }
});
