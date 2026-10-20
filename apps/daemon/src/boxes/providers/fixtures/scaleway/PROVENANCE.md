# Scaleway fixtures

- Recorded 2026-10-19 from the public (unauthenticated) catalog endpoints of `https://api.scaleway.com`, trimmed to a few
  types per zone: `products-servers-*` and `availability-*` (`/instance/v1/zones/{zone}/products/servers[/availability]`),
  `marketplace-images` (`/marketplace/v2/images`), `local-images-*` (`/marketplace/v2/local-images`, compatible types
  trimmed), `error-unauthorized` (an unauthenticated `/servers` call). `DEV1-S` in fr-par-1 is marked `end_of_service`
  by hand to exercise the filter.
- Built from the Instance API field definitions (https://www.scaleway.com/en/developers/api/instance/, `@scaleway/sdk-instance`
  2.26.0 types): `create-server`, `server-running`, `servers-managed-*`, `servers-empty`, `action-poweron`, and the
  error bodies `error-not-found`, `error-rate-limit`, `error-quota`, `error-internal` (Scaleway's `{message, type}` shape).
- Redacted: server, volume, IP, organization and project ids are `1111…`-style UUIDs; public IPs are in 203.0.113.0/24;
  the box id and name are the test box's.
