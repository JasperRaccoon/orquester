/**
 * Lending managed accounts to boxes (lending spec 2026-11-03). `service.ts` — records, resolving,
 * install, every way a lend ends; `keeper.ts` — one lend's login kept current; `routes.ts` — the
 * account-lend routes.
 */

export { registerAccountLendRoutes } from "./routes.ts";
export { AccountLendError, AccountLends, hasActiveLend, type AccountLendsDeps, type LendEndReason } from "./service.ts";
