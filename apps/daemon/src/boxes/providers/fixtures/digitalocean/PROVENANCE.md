# DigitalOcean fixtures

- Built 2026-10-19 from the documented examples and schemas of the DigitalOcean API reference
  (https://docs.digitalocean.com/reference/api/digitalocean/ and https://github.com/digitalocean/openapi:
  `sizes/models/size.yml`, `sizes/models/gpu_info.yml`, `regions/models/region.yml`, the Droplet, SSH key and
  error examples); no live account was used. GPU plan slugs and prices follow
  https://www.digitalocean.com/pricing/gpu-droplets.
- Trimmed to a few sizes and regions; `droplets-managed` has a second, synthesized Droplet.
- Redacted: Droplet, action and key ids renumbered; public IPs moved to 203.0.113.0/24 and 2001:db8::/32; key
  material, fingerprints and request ids replaced; the box id is the test box id.
