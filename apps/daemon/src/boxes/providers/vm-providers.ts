/**
 * The VM providers of spec §11.1 (Linux, Linux + GPU and Windows VMs). One
 * adapter per file; `providers/index.ts` assembles these with the GPU
 * marketplaces and Blacksmith into the registry.
 */

import type { BoxProviderAdapter } from "../contracts.ts";
import { civoAdapter } from "./civo.ts";
import { digitaloceanAdapter } from "./digitalocean.ts";
import { exoscaleAdapter } from "./exoscale.ts";
import { flyAdapter } from "./fly.ts";
import { hetznerAdapter } from "./hetzner.ts";
import { ionosAdapter } from "./ionos.ts";
import { linodeAdapter } from "./linode.ts";
import { morphAdapter } from "./morph.ts";
import { oracleAdapter } from "./oracle.ts";
import { ovhAdapter } from "./ovh.ts";
import { scalewayAdapter } from "./scaleway.ts";
import { upcloudAdapter } from "./upcloud.ts";
import { vultrAdapter } from "./vultr.ts";

/** In the catalog order of `BOX_PROVIDER_IDS`. */
export const VM_PROVIDER_ADAPTERS: readonly BoxProviderAdapter[] = [
  hetznerAdapter,
  vultrAdapter,
  ionosAdapter,
  ovhAdapter,
  scalewayAdapter,
  digitaloceanAdapter,
  exoscaleAdapter,
  linodeAdapter,
  flyAdapter,
  morphAdapter,
  civoAdapter,
  oracleAdapter,
  upcloudAdapter
];
