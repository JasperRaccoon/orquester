# UpCloud fixtures

- Built 2026-10-19 from the documented examples and schemas (no live account): https://developers.upcloud.com/1.3/
  (4-pricing, 5-zones, 7-plans, 8-servers, 9-storages, 2-architecture for errors) and the OpenAPI document at
  https://developers.upcloud.com/api/1.3/upcloud-openapi.json (plan `family`/`current_offering`, server `created`,
  `pending_delete`, the `{code,message}` 409 shape).
- Plan names, template titles and prices follow the documented formats (prices in cents per hour); the US price,
  the Cloud Native plan and the templates beyond the documented Ubuntu 22.04 one are illustrative values.
- Redacted: server and storage ids are `00111111-…`/`01222222-…`, IPs from 203.0.113.0/24 and 2001:db8::/32, the
  account username is a placeholder.
