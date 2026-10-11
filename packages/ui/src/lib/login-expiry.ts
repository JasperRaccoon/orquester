import type { AgentAccount } from "@orquester/api";

export type LoginStatus = Partial<Pick<AgentAccount, "loginExpiresAt" | "needsReauth">>;

/** Warn during the final week, using the largest remaining unit. */
export function loginExpiryWarning(login: LoginStatus, now: number): string | null {
  if (login.needsReauth) return "Login expired, please re-login";
  const expiry = login.loginExpiresAt ? Date.parse(login.loginExpiresAt) : NaN;
  if (!Number.isFinite(expiry)) return null;
  const remaining = expiry - now;
  if (remaining <= 0) return "Login expired, please re-login";
  if (remaining > 7 * 86_400_000) return null;
  const [size, unit] = remaining >= 86_400_000
    ? [86_400_000, "day"] as const
    : remaining >= 3_600_000
      ? [3_600_000, "hour"] as const
      : [60_000, "minute"] as const;
  const count = Math.ceil(remaining / size);
  return `Login expires in ${count} ${unit}${count === 1 ? "" : "s"}`;
}
