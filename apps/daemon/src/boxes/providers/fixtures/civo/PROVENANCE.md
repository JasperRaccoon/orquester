# Civo fixtures

- Built 2026-10-19 from the documented examples of the Civo API (https://www.civo.com/api/instances,
  https://www.civo.com/api/sizes, https://www.civo.com/api/disk-images, https://www.civo.com/api/networks,
  https://www.civo.com/api/regions) and the field names of Civo's Go client (https://github.com/civo/civogo:
  `instance.go`, `instance_size.go`, `disk_image.go`, `network.go`, `region.go`, `errors.go`); no live account was used.
- Synthesized for coverage: extra sizes (a non-selectable one, an unknown family, a GPU, Kubernetes and database
  sizes), the image list, a second network, instances in two regions, and the `{ code, reason }` error bodies.
- Redacted: all ids replaced with `11111111-…`-style UUIDs; public IPs moved to 203.0.113.0/24; passwords and
  tokens replaced; the box id is the test box id.
