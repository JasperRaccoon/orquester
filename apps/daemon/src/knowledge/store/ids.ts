import { randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE32[bytes[i]! & 31];
  return out;
}

/** `ke_` + 12 lowercase base32 characters (60 random bits). */
export function newKnowledgeEntryId(): string {
  return `ke_${base32(12)}`;
}

/** `kc_` + 10 lowercase base32 characters (50 random bits). */
export function newKnowledgeCollectionId(): string {
  return `kc_${base32(10)}`;
}
