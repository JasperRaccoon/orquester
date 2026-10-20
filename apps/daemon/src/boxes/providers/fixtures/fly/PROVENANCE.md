# Fly.io Machines fixtures

- `regions` was recorded 2026-10-19 from the public `GET https://api.machines.dev/v1/platform/regions` (trimmed to five
  regions; `mad` (deprecated) and `xyz` (unknown to the price table) are synthesized). `error-unauthorized` and
  `error-not-found` are the bodies the live API returned 2026-10-19 to an invalid token.
- The rest is built 2026-10-19 from the documented examples and schemas: https://fly.io/docs/machines/api/apps-resource/,
  https://fly.io/docs/machines/api/machines-resource/ and https://docs.machines.dev/openapi.json (`ErrorResponse.status`
  values `name_taken`, `insufficient_capacity`); error wording beyond the observed bodies is synthesized.
- Redacted: app and Machine ids renumbered (`11111111…`), the 6PN private address renumbered (`fdaa:0:1111:…`), the
  image digest replaced with `1…`, the box id and names replaced with the test box id; no organization names or emails.
