# Exoscale fixtures

- Recorded 2026-10-19 from Exoscale's public, unauthenticated endpoints and trimmed to a few entries:
  `zones` (`GET https://api-ch-gva-2.exoscale.com/v2/zone`), `instance-types` (`/v2/instance-type`, zone lists shortened,
  `memory.extra-large` narrowed to one zone), `templates` (`/v2/template?visibility=public`), `pricing-opencompute` and
  `pricing-licenses` (`https://portal.exoscale.com/api/pricing/{opencompute,licenses}`). Nothing needed redacting.
- Built from the documented schemas at https://openapi-v2.exoscale.com/ (operation, instance, instance-password):
  `create-operation*`, `operation-failed`, `delete-operation`, `instance-running`, `instances-*`, `instance-password`.
  Ids are `11111111-…`/`22222222-…`, IPs from 203.0.113.0/24 and 2001:db8::/32, the password is a placeholder.
- Error bodies use the API's `{"message": …}` shape; `error-forbidden` is the live answer to a bad signature.
