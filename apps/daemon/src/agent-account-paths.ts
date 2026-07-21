import { realpath, lstat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

export const ACCOUNT_MARKER = ".orq-account";

export class AgentAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccountError";
  }
}

export async function assertOwnedAccountHome(
  accountsDir: string,
  agent: string,
  id: string,
  home: string
): Promise<void> {
  // The home must not itself be a symlink (a swapped link could redirect writes).
  let st;
  try {
    st = await lstat(home);
  } catch {
    throw new AgentAccountError(`Account home is missing: ${agent}/${id}`);
  }
  if (st.isSymbolicLink()) {
    throw new AgentAccountError(`Account home is a symlink: ${agent}/${id}`);
  }
  // Canonicalize both sides so /var vs /private/var and any parent symlink can't fool us.
  const realRoot = await realpath(accountsDir);
  const expected = join(realRoot, agent, id, "home");
  const realHome = await realpath(home);
  if (realHome !== expected && !realHome.startsWith(expected + sep)) {
    throw new AgentAccountError(`Account home is outside the accounts dir: ${agent}/${id}`);
  }
  if (realHome !== expected) {
    throw new AgentAccountError(`Account home path shape is wrong: ${agent}/${id}`);
  }
  let marker: string;
  try {
    marker = (await readFile(join(home, ACCOUNT_MARKER), "utf8")).trim();
  } catch {
    throw new AgentAccountError(`Account marker missing: ${agent}/${id}`);
  }
  if (marker !== id) {
    throw new AgentAccountError(`Account marker mismatch: ${agent}/${id}`);
  }
}
