# Akamai Cloud (Linode) fixtures

- Built 2026-10-19 from the documented examples and schemas of the Linode API v4 reference
  (https://techdocs.akamai.com/linode-api/reference/api, OpenAPI spec 4.215.0 at
  https://github.com/linode/linode-api-docs): list types, regions, regions/availability, create/get/list Linode
  instances, and the `errors[].reason` error envelope; no live account was used. Plan prices follow
  https://www.linode.com/pricing/.
- Trimmed to a few types and regions; `instances-managed` adds two synthesized instances (one untagged, one unrelated).
- Redacted: instance ids renumbered; public IPs moved to 203.0.113.0/24 and 2001:db8::/32; host UUIDs replaced;
  the box id is the test box id.
