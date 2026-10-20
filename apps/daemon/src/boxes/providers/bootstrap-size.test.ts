// Every adapter's bootstrap delivery fits its provider's size limit with worst-case inputs:
// Tailscale on, a 200-character daemon URL, a 64-character box id, a hub-issued bootstrap token
// (`<boxId>.<43 base64url chars>`, hub.ts) and a long Tailscale auth key. The payload each
// adapter sends is rebuilt with the same exported helpers the adapter calls.
//
// Limits and their sources (checked 2026-10). Where a provider documents none, the test holds the
// payload to a conservative 16 KiB (UNDOCUMENTED below) — cloud-init user data limits of providers
// that do document one start at 16 KiB, and a payload under it fails nowhere we know of.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoxKind } from "@orquester/api";

import { buildBootstrap } from "../bootstrap/bootstrap.ts";
import type { BoxBootstrap, BoxProviderAdapter } from "../contracts.ts";
import { blacksmithRunnerLabel, BLACKSMITH_IMAGES, BLACKSMITH_MAX_LIFETIME_MINUTES, BLACKSMITH_SIZES } from "../github/workflow-template.ts";
import { CONTAINER_PROVIDERS } from "../service/lifecycle.ts";
import { BLACKSMITH_ADAPTER } from "./blacksmith.ts";
import { detachedStartCommand } from "./gpu-common.ts";
import { GPU_PROVIDER_ADAPTERS } from "./gpu-providers.ts";
import { jarvisStartupScript } from "./jarvislabs.ts";
import { bootstrapCommand } from "./morph.ts";
import { tensordockCloudInit } from "./tensordock.ts";
import { VAST_ONSTART_MAX } from "./vastai.ts";
import { base64, cloudbaseInitUserData, userDataFor } from "./vm-common.ts";
import { VM_PROVIDER_ADAPTERS } from "./vm-providers.ts";
import { vultrWindowsBootScript } from "./vultr.ts";

const KIB = 1024;
/** No documented limit: a conservative bound (see the header). */
const UNDOCUMENTED = 16 * KIB;
/** Linux `MAX_ARG_STRLEN` (32 pages of 4 KiB): the longest single argv string execve accepts (man 2 execve). */
const MAX_ARG_STRLEN = 131_072;

const BOX_ID = "b".repeat(64);
const WORST = {
  boxId: BOX_ID,
  daemonUrl: `https://orq-host.tail1234.ts.net:8443/${"p".repeat(162)}`,
  bootstrapToken: `${BOX_ID}.${"A".repeat(43)}`,
  // Real keys are `tskey-auth-<id>CNTRL-<secret>`, about 60 characters.
  tailscaleAuthKey: `tskey-auth-k${"0".repeat(16)}CNTRL-${"x".repeat(70)}`
};
const SSH_PUBLIC_KEY = `ssh-ed25519 ${"A".repeat(68)} orq-box`;

interface Delivery {
  /** The bytes the adapter sends for this bootstrap and kind (what the limit applies to). */
  payload(bootstrap: BoxBootstrap, kind: BoxKind): string;
  limit: number;
  source: string;
}

const deliveries: Record<string, Delivery> = {
  hetzner: {
    payload: (b) => b.cloudInit,
    limit: 32 * KIB,
    source: "docs.hetzner.cloud: user_data 'is limited to 32KiB'"
  },
  vultr: {
    payload: (b, kind) => base64(kind === "windows" ? vultrWindowsBootScript(b) : b.cloudInit),
    limit: UNDOCUMENTED,
    source: "UNDOCUMENTED (base64 user_data / startup script)"
  },
  ionos: { payload: (b) => base64(b.cloudInit), limit: UNDOCUMENTED, source: "UNDOCUMENTED (base64 volume userData)" },
  ovh: {
    // OVH Public Cloud is OpenStack: Nova takes user data as base64 of at most 65535 bytes.
    payload: (b, kind) => base64(kind.startsWith("windows") ? cloudbaseInitUserData(b) : b.cloudInit),
    limit: 65_535,
    source: "OpenStack Nova create-server schema: base64 user_data maxLength 65535"
  },
  scaleway: { payload: (b) => b.cloudInit, limit: UNDOCUMENTED, source: "UNDOCUMENTED (user_data cloud-init key)" },
  digitalocean: {
    payload: (b) => b.cloudInit,
    limit: 64 * KIB,
    source: "DigitalOcean API: user_data 'may not exceed 64 KiB in size'"
  },
  exoscale: {
    payload: (b, kind) => base64(userDataFor(kind, b)),
    limit: 32_768,
    source: "Exoscale API v2 create-instance: user-data (base64) maxLength 32768"
  },
  linode: {
    payload: (b) => base64(b.cloudInit),
    limit: 65_535,
    source: "Akamai/Linode API: metadata.user_data 'can't exceed 65535 bytes when encoded'"
  },
  fly: { payload: (b) => base64(b.posixScript), limit: UNDOCUMENTED, source: "UNDOCUMENTED (config.files[].raw_value)" },
  morph: {
    payload: (b) => bootstrapCommand(b.posixScript)[2]!,
    limit: MAX_ARG_STRLEN,
    source: "exec argv run over SSH; Linux MAX_ARG_STRLEN per argument"
  },
  civo: { payload: (b) => b.posixScript, limit: UNDOCUMENTED, source: "UNDOCUMENTED (instance script)" },
  oracle: {
    payload: (b, kind) =>
      JSON.stringify({ user_data: base64(userDataFor(kind, b)), ...(kind === "windows" ? {} : { ssh_authorized_keys: SSH_PUBLIC_KEY }) }),
    limit: 32_000,
    source: "OCI LaunchInstanceDetails: metadata + extendedMetadata at most 32,000 bytes combined"
  },
  upcloud: { payload: (b) => b.cloudInit, limit: UNDOCUMENTED, source: "UNDOCUMENTED (user_data)" },
  vastai: {
    payload: (b) => b.stagedPosixScript!,
    limit: VAST_ONSTART_MAX,
    source: "vast.ai create-instance: onstart 'is limited to 4048 characters'"
  },
  runpod: {
    payload: (b) => b.containerCommand.join(" "),
    limit: UNDOCUMENTED,
    source: "UNDOCUMENTED (pod entrypoint; argv itself allows 128 KiB per string)"
  },
  hyperstack: {
    payload: (b) => base64(b.cloudInit),
    limit: 65_535,
    source: "Hyperstack docs: base64 cloud-init 'cannot exceed 65,535 bytes'"
  },
  cloudrift: { payload: (b) => detachedStartCommand(b.posixScript), limit: UNDOCUMENTED, source: "UNDOCUMENTED (cloudinit_commands)" },
  massed: { payload: (b) => detachedStartCommand(b.posixScript), limit: UNDOCUMENTED, source: "UNDOCUMENTED (launch command)" },
  jarvislabs: { payload: (b) => jarvisStartupScript(b.posixScript), limit: UNDOCUMENTED, source: "UNDOCUMENTED (startup script upload)" },
  tensordock: {
    payload: (b) => JSON.stringify(tensordockCloudInit(b.posixScript)),
    limit: UNDOCUMENTED,
    source: "UNDOCUMENTED (cloud_init object)"
  },
  blacksmith: {
    // Only the daemon URL travels (as a workflow_dispatch input); the workflow downloads orq-agent itself.
    payload: (b) =>
      JSON.stringify({
        box_id: BOX_ID,
        lifetime_minutes: String(BLACKSMITH_MAX_LIFETIME_MINUTES),
        daemon_url: b.env.ORQ_DAEMON_URL,
        runner: blacksmithRunnerLabel(BLACKSMITH_SIZES.at(-1)!.id, BLACKSMITH_IMAGES.at(-1)!.id)
      }),
    limit: 65_535,
    source: "GitHub workflow_dispatch: 'The maximum payload for inputs is 65,535 characters'"
  }
};

const ADAPTERS: readonly BoxProviderAdapter[] = [...VM_PROVIDER_ADAPTERS, ...GPU_PROVIDER_ADAPTERS, BLACKSMITH_ADAPTER];

test("every adapter that can create a box has a delivery entry here", () => {
  const creating = ADAPTERS.filter((adapter) => adapter.kinds.length > 0).map((adapter) => adapter.id);
  assert.deepEqual(Object.keys(deliveries).sort(), [...creating].sort());
  // Thunder Compute has no way to deliver a bootstrap, so it offers no kinds at all.
  assert.deepEqual(
    ADAPTERS.filter((adapter) => adapter.kinds.length === 0).map((adapter) => adapter.id),
    ["thunder"]
  );
});

test("every adapter's bootstrap payload fits its provider's limit with worst-case inputs", () => {
  assert.equal(WORST.daemonUrl.length, 200);
  for (const adapter of ADAPTERS) {
    const delivery = deliveries[adapter.id];
    if (adapter.kinds.length === 0) continue;
    assert.ok(delivery, `${adapter.id}: no delivery entry`);
    for (const tailscale of [true, false]) {
      const bootstrap = buildBootstrap({
        ...WORST,
        tailscaleAuthKey: tailscale ? WORST.tailscaleAuthKey : null,
        container: CONTAINER_PROVIDERS.has(adapter.id)
      });
      for (const kind of adapter.kinds) {
        const size = Buffer.byteLength(delivery.payload(bootstrap, kind), "utf8");
        assert.ok(
          size <= delivery.limit,
          `${adapter.id} (${kind}, Tailscale ${tailscale ? "on" : "off"}): ${size} bytes > ${delivery.limit} (${delivery.source})`
        );
      }
    }
  }
});

test("vast.ai needs the staged bootstrap: the single-stage script with Tailscale does not fit onstart", () => {
  const bootstrap = buildBootstrap({ ...WORST, container: true });
  assert.ok(bootstrap.posixScript.length > VAST_ONSTART_MAX);
  assert.ok(bootstrap.containerCommand[2]!.length > VAST_ONSTART_MAX);
  assert.ok(bootstrap.stagedPosixScript!.length <= VAST_ONSTART_MAX);
});
