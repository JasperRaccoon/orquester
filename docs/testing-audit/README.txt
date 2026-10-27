Test-suite cleanup and integration audit

Initial audit: 959 test/check files, 272,366 test LOC, 10,570 source test declarations. Every declaration maps to a disposition in the area JSON/Markdown ledgers. Seven test files and 1,861 net test LOC were removed; 10,404 declarations survive before incoming feature integration. Parameterized families count once in this aggregate; area ledgers also identify expanded cases.

The initial cleanup passed pnpm check and pnpm check:changed --no-cache. The first changed gate exposed eight fixture/oracle failures and one type-inference error; all were fixed, including two independently verified production defects: unknown persisted change states being deleted by retention, and repeated workflow secret protection nesting existing markers. The second changed gate passed every package.

Remote feature integration and its incoming-test audit are in progress. Whole-suite and build validation have not yet completed for the integrated tree. Final measurements and delivery status will replace this progress note before push.

See initial-summary.json for exact initial counts; each named area .md/.json for per-test independent-contract evidence, stable seams, credible failures and surviving coverage.
