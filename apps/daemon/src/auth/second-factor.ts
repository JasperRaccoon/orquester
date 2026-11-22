/**
 * The remote login's second factor, `auth-second-factor.json` (`@orquester/config`): one
 * authenticator (TOTP) secret and ten one-time recovery codes.
 *
 * - Loaded once at boot. No file → the factor is off (deleting it is the server-side reset,
 *   `deploy.sh reset-2fa`). A file that cannot be read or parsed → the factor counts as ON and
 *   UNUSABLE ({@link SecondFactorUnavailableError} from every check and change): the file is never
 *   moved aside or written over, so a damaged file can never turn the factor off (fail closed).
 * - A `code` is an authenticator code when it normalises to exactly six digits, else a recovery
 *   code. An accepted code is used up at once, in memory, before anything awaits: a TOTP code's step
 *   becomes `lastUsedStep` (that step and earlier ones are refused from then on), a recovery code is
 *   removed. So the same code can never succeed twice, however the checks interleave.
 * - Recovery codes are kept as SHA-256 digests only (high-entropy codes behind a throttle need no
 *   slow hash); the secret is the one value in the file that authenticates, hence 0600.
 * - Writes are atomic, 0600 and serialized; a failed write rejects the change that asked for it.
 *   Whatever the file holds that this build does not know is written back verbatim.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AuthSecondFactorStatusResponse } from "@orquester/api";
import {
  createDefaultAuthSecondFactorFile,
  parseAuthSecondFactorFile,
  serializeAuthSecondFactorFile,
  type AuthSecondFactorFile
} from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";
import { matchTotp } from "./totp.ts";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
/** 32 symbols without i, l, o, u: about 50 bits per code. */
const RECOVERY_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** The factor's file exists but cannot be used: no password login can finish. */
export class SecondFactorUnavailableError extends Error {
  constructor() {
    super("Two-step sign-in is unavailable: auth-second-factor.json cannot be read. Fix it or run `deploy.sh reset-2fa`, then restart Orquester.");
    this.name = "SecondFactorUnavailableError";
  }
}

export interface SecondFactorStoreOptions {
  /** Absent: memory only (route tests). */
  file?: string;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error">;
}

/** Case, spaces and dashes dropped; the look-alikes `o`, `i`, `l` read as `0`, `1`, `1`. */
function normalizeCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]+/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
}

function digestHex(normalized: string): string {
  return createHash("sha256").update(`orquester-recovery-code\u0000${normalized}`, "utf8").digest("hex");
}

function newRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export class SecondFactorStore {
  private state: AuthSecondFactorFile = createDefaultAuthSecondFactorFile();
  private unavailable = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SecondFactorStoreOptions = {}) {}

  /** The clock the factor (and its challenges and lockouts) runs on. */
  now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Read the file. Missing → off; unreadable or unparsable → on and unusable. Never throws. */
  async load(): Promise<void> {
    this.state = createDefaultAuthSecondFactorFile();
    this.unavailable = false;
    if (!this.opts.file) return;
    let text: string;
    try {
      text = await readFile(this.opts.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.markUnavailable(`could not be read (${code ?? "unknown error"})`);
      return;
    }
    try {
      this.state = parseAuthSecondFactorFile(JSON.parse(text));
    } catch (error) {
      this.markUnavailable(`does not parse (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (this.state.unreadableRecoveryCodes.length > 0) {
      this.opts.logger?.warn(`auth-second-factor.json: ${this.state.unreadableRecoveryCodes.length} recovery code record(s) this build cannot read are never accepted; they stay in the file.`);
    }
  }

  private markUnavailable(detail: string): void {
    this.unavailable = true;
    this.state = createDefaultAuthSecondFactorFile();
    this.opts.logger?.error(`auth-second-factor.json ${detail}; two-step sign-in counts as on and no password login can finish until it is fixed (or reset with \`deploy.sh reset-2fa\`) and the daemon restarts.`);
  }

  /** Wait for every queued write (failed ones included). */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): Promise<void> {
    const file = this.opts.file;
    if (!file || this.unavailable) return Promise.resolve();
    const text = `${serializeAuthSecondFactorFile(this.state)}\n`;
    const write = () => writeFileAtomic(file, text, 0o600, false);
    const run = this.writes.then(write, write);
    this.writes = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      this.opts.logger?.error("Failed to persist auth-second-factor.json", error instanceof Error ? error.name : typeof error);
      throw error;
    });
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new SecondFactorUnavailableError();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** On, or unusable (which counts as on). */
  isEnabled(): boolean {
    return this.unavailable || this.state.totp !== undefined;
  }

  isUnavailable(): boolean {
    return this.unavailable;
  }

  /** What Settings shows. Never the secret or a code. */
  status(): AuthSecondFactorStatusResponse {
    if (this.unavailable) {
      return { enabled: true, enabledAt: null, recoveryCodesRemaining: 0, unavailable: true, lastFailedChallenge: null };
    }
    const { totp, recoveryCodes, lastFailedChallenge } = this.state;
    return {
      enabled: totp !== undefined,
      enabledAt: totp?.enabledAt ?? null,
      recoveryCodesRemaining: totp ? recoveryCodes.length : 0,
      unavailable: false,
      lastFailedChallenge: lastFailedChallenge ? { at: lastFailedChallenge.at, ip: lastFailedChallenge.ip } : null
    };
  }

  // -------------------------------------------------------------------------
  // Checks
  // -------------------------------------------------------------------------

  /**
   * Check `code` (an authenticator code or a recovery code) and use it up when it is right. False
   * when it is wrong or the factor is off. Throws {@link SecondFactorUnavailableError}, or the write
   * error when the use could not be recorded (the code stays used for this run either way).
   */
  async verify(code: string): Promise<boolean> {
    this.assertAvailable();
    const totp = this.state.totp;
    if (!totp || typeof code !== "string") return false;
    const normalized = normalizeCode(code);
    if (/^\d{6}$/.test(normalized)) {
      const step = matchTotp(totp.secret, normalized, this.now(), totp.lastUsedStep);
      if (step === null) return false;
      this.state = { ...this.state, totp: { ...totp, lastUsedStep: step } };
      await this.persist();
      return true;
    }
    const given = Buffer.from(digestHex(normalized), "hex");
    let match = -1;
    // Every stored digest is compared (no early exit).
    this.state.recoveryCodes.forEach((record, index) => {
      if (timingSafeEqual(Buffer.from(record.digest, "hex"), given)) match = index;
    });
    if (match < 0) return false;
    this.state = { ...this.state, recoveryCodes: this.state.recoveryCodes.filter((_, index) => index !== match) };
    await this.persist();
    return true;
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  /**
   * Turn the factor on with `secret` if `code` is a current code for it. Returns the ten new
   * recovery codes (shown once), `"enabled"` when it is already on, `"invalid-code"` when the code
   * is wrong. The enrolling code's step counts as used.
   */
  async enable(secret: string, code: string): Promise<string[] | "enabled" | "invalid-code"> {
    this.assertAvailable();
    if (this.state.totp) return "enabled";
    const normalized = normalizeCode(code);
    const step = /^\d{6}$/.test(normalized) ? matchTotp(secret, normalized, this.now()) : null;
    if (step === null) return "invalid-code";
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    this.state = {
      ...this.state,
      totp: { secret, enabledAt: new Date(this.now()).toISOString(), lastUsedStep: step },
      recoveryCodes: codes.map((value) => ({ digest: digestHex(normalizeCode(value)) })),
      unreadableRecoveryCodes: []
    };
    await this.persist();
    return codes;
  }

  /** Replace every recovery code with ten new ones (shown once). Null when the factor is off. */
  async regenerateRecoveryCodes(): Promise<string[] | null> {
    this.assertAvailable();
    if (!this.state.totp) return null;
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    this.state = {
      ...this.state,
      recoveryCodes: codes.map((value) => ({ digest: digestHex(normalizeCode(value)) })),
      unreadableRecoveryCodes: []
    };
    await this.persist();
    return codes;
  }

  /** Turn the factor off (secret and recovery codes dropped). False when it already was. */
  async disable(): Promise<boolean> {
    this.assertAvailable();
    if (!this.state.totp) return false;
    const { totp: _dropped, ...rest } = this.state;
    this.state = { ...rest, recoveryCodes: [], unreadableRecoveryCodes: [] };
    await this.persist();
    return true;
  }

  /** Remember a correct-password-wrong-code attempt for Settings (the latest one wins). */
  async recordFailedChallenge(ip: string): Promise<void> {
    this.assertAvailable();
    this.state = { ...this.state, lastFailedChallenge: { at: new Date(this.now()).toISOString(), ip: ip.slice(0, 200) } };
    await this.persist();
  }

  /** Clear the Settings alert. */
  async dismissAlert(): Promise<void> {
    this.assertAvailable();
    if (!this.state.lastFailedChallenge) return;
    const { lastFailedChallenge: _dropped, ...rest } = this.state;
    this.state = rest;
    await this.persist();
  }
}
