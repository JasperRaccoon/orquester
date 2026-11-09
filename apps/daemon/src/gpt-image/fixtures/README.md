# ChatGPT image endpoint fixtures

Real answers of `POST https://chatgpt.com/backend-api/codex/images/generations` and `…/images/edits`,
captured once on **2026-11-10** by a throwaway Node script (not committed) against one ChatGPT Pro
Codex account the owner picked for the spike (design
`docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §4.1). The script read the account's
`auth.json` read-only and never refreshed it. There is no record mode.

Each file is `{note, request, status, headers, body}`:

- `request` is what was sent: the path, the header names (values never), and the JSON body.
- `headers` keeps only `content-type`, `retry-after`, `x-codex-*`, `x-ratelimit-*`, `openai-*`, and
  request ids.
- `body` is the response JSON.

## Redaction

- Image bytes: every `data[].b64_json` is replaced by a 2×2 PNG of the same kind (RGB for opaque,
  RGBA for transparent). The real sizes are in each `note` and in the `size` field.
- `generation_id` → the all-zero UUID; `x-codex-imagegen-request-id` and `cf-ray` → `<id>`.
- The bearer token, the ChatGPT account id and the email never appear. A leak scan for them and for
  JWT-shaped text ran over every file before commit.

## The files

| File | Request | What it shows |
|---|---|---|
| `generations-200.json` | generations, `size: "1024x1024"`, `quality: "low"` | The success shape: `{created, background, data: [{b64_json, generation_id}], output_format: "png", quality, size, usage}`. No `revised_prompt`. Size not honored (1536×1024 came back). |
| `generations-transparent-200.json` | generations, `background: "transparent"` | A real alpha channel (the real PNG was colour type 6, most pixels alpha 0). `quality: "low"` asked, `medium` came back. |
| `edits-200.json` | edits, one `data:image/png` reference, `quality: "auto"`, `size: "auto"` | The edit shape is the same as generations; `usage.input_tokens_details.image_tokens` counts the reference. |
| `error-400-missing-prompt.json` | generations without `prompt` | `{error: {message, type: "invalid_request_error", param, code: "missing_required_parameter"}}`, with the `x-codex-*` limit headers. |
| `error-400-invalid-image.json` | edits with a non-image `image_url` | `{error: {…, type: "image_generation_user_error", code: "invalid_image_file"}}`. |
| `error-401-invalid-token.json` | a garbage bearer | `{detail: "Could not parse your authentication token. Please try signing in again."}`, no limit headers. |

## Spike findings not captured as files

- Minimum headers: `Authorization` alone is accepted (the account id header was not required for this
  single-workspace account). The daemon still sends `ChatGPT-Account-Id` and Codex's `originator`.
- `size`: not honored. `1024x1024` gave 1536×1024, `1024x1536` gave 1312×1199, a bad `13x7` gave
  1536×1024 with no error.
- `quality`: not honored. `high` and `auto` both came back `low` for opaque images.
- Quota, Free plan and safety refusals could not be observed safely. Their mapping follows
  `openai/codex` `codex-rs/codex-api/src/api_bridge.rs` (429 `{error: {type: "usage_limit_reached",
  resets_at, plan_type}}`, `usage_not_included`, 400 policy codes) and is tested with inline bodies,
  not fixtures.
