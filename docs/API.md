# API reference

Base path: **`/api/v1`**, served on the same origin as the app. The
machine-readable contract is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1, linted
with Redocly). This page covers the same ground with examples.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/images/process` | Process one image and return the result bytes |
| `GET` | `/capabilities` | Current limits and formats |
| `GET` | `/feedback` | Public review wall: rating summary and recent comments |
| `POST` | `/feedback` | Submit a 1–5 star rating with an optional comment |
| `*` | `/admin/*` | Review moderation (session cookie); see [Admin API](#admin-api) |
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness and load |

## `POST /images/process`

`multipart/form-data` with two parts:

| Part | Required | Content |
| --- | --- | --- |
| `file` | yes | Exactly one image, up to `MAX_UPLOAD_MB` (default 25 MB). JPEG, PNG, WebP, AVIF, GIF (first frame) or TIFF (first page). Identified **by content**; the filename and declared MIME type are ignored. |
| `options` | no | JSON string (≤ 4 KB) matching [`ProcessOptions`](#processoptions). Omit it to re-encode with defaults. |

### Order of operations

`EXIF orientation → rotate → flip → crop → resize → flatten (JPEG) → encode → strip metadata`

`crop` coordinates are pixels of the image **after** orientation, rotation
and flipping, which is exactly what the app's preview shows.

### `ProcessOptions`

Unknown keys are rejected (`422`).

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `crop` | `{left, top, width, height}` integers | none | Must lie fully inside the transformed image, otherwise `422 crop_out_of_bounds`. |
| `rotate` | `0 \| 90 \| 180 \| 270` | `0` | Clockwise. |
| `flipH` | boolean | `false` | Mirror left↔right in the rotated frame. |
| `flipV` | boolean | `false` | Mirror top↔bottom in the rotated frame. |
| `resize.width` / `resize.height` | integer 1…`MAX_OUTPUT_DIMENSION` | none | At least one is required. With one, the aspect ratio is preserved. |
| `resize.fit` | `cover \| contain \| fill \| inside \| outside` | `inside` | See [fit modes](#fit-modes). |
| `resize.position` | `center \| attention \| entropy` | `center` | What `cover` keeps. `attention` = salient regions (faces, skin, saturated colour); `entropy` = most detail. |
| `resize.withoutEnlargement` | boolean | `false` | Never upscale. |
| `format` | `original \| jpeg \| png \| webp \| avif` | `original` | `original` keeps JPEG/PNG/WebP/AVIF; GIF and TIFF become PNG (with alpha) or JPEG. |
| `quality` | integer 1–100 | `82` | JPEG/WebP/AVIF. With `targetSizeBytes` it is the **maximum** quality. Ignored for PNG. |
| `targetSizeBytes` | integer 1,024 – 209,715,200 | none | Byte budget; see [target size](#target-file-size). |
| `allowDownscale` | boolean | `true` | Allow reducing dimensions when quality alone cannot reach the budget. |
| `background` | `#rrggbb \| transparent` | `#ffffff` | Letterbox fill for `contain`, and the flatten colour for JPEG. `transparent` applies to PNG/WebP/AVIF. |

#### Fit modes

When both `width` and `height` are set:

| `fit` | Result size | Behaviour |
| --- | --- | --- |
| `cover` | exactly W×H | Scales to fill the box, then trims the overflow (using `position`). |
| `contain` | exactly W×H | Scales to fit inside the box and pads it with `background`. |
| `fill` | exactly W×H | Stretches, ignoring the aspect ratio. |
| `inside` | ≤ W×H | Scales so both sides fit; keeps the aspect ratio. |
| `outside` | ≥ W×H | Scales so both sides cover the box; keeps the aspect ratio; no trimming. |

With `withoutEnlargement`, `cover`/`fill` clamp each side to the source,
`inside`/`outside` never scale above 1×, and `contain` keeps a W×H canvas
without enlarging the content. The UI's size preview uses the same rules,
which are tested against real sharp output.

#### Target file size

The server searches for the **highest quality that fits**. It first tries
`quality` as given (PNG tries lossless first), then binary-searches down to
a floor of 40. If even that is too large and `allowDownscale` is true,
dimensions shrink by about √(budget / size) and the search repeats. The
final attempt may go down to quality 1. If the budget still cannot be met,
the smallest encoding is returned with `X-Target-Met: false`. The API never
claims a budget was met unless it was measured.

### Success response

`200` with the image bytes. Metadata (EXIF, GPS, XMP, ICC) is stripped and
colour is converted to sRGB.

| Header | Example | Meaning |
| --- | --- | --- |
| `Content-Type` | `image/webp` | Output format. |
| `Content-Disposition` | `attachment; filename="holiday-photo-processed.webp"` | Sanitised ASCII name derived from the upload. |
| `Cache-Control` | `no-store` | Results are never cached. |
| `X-Output-Width` / `X-Output-Height` | `1200` / `675` | Final pixel size. |
| `X-Output-Bytes` | `42112` | Body length. |
| `X-Output-Format` | `webp` | `jpeg`, `png`, `webp` or `avif`. |
| `X-Output-Quality` | `74` or `lossless` | Encoder quality actually used. |
| `X-Target-Met` | `true`, `false` or `n/a` | Whether `targetSizeBytes` was met. |
| `X-Downscaled` | `false` | `true` if dimensions were reduced to meet the budget. |
| `X-Input-Width` / `X-Input-Height` | `3000` / `2000` | Source size after EXIF orientation. |
| `X-Input-Bytes` / `X-Input-Format` | `1648123` / `jpeg` | Upload size and detected format. |
| `X-Processing-Time-Ms` | `173` | Server-side processing time. |
| `X-Request-Id` | UUID | Correlates with server logs. |

These headers are listed in `Access-Control-Expose-Headers` for allowed
cross-origin callers.

### Examples

```bash
# Resize to 1200 px wide WebP
curl -sS -o out.webp \
  -F "file=@photo.jpg" \
  -F 'options={"resize":{"width":1200},"format":"webp","quality":80}' \
  https://resizer.example.com/api/v1/images/process

# Square Instagram crop, smart focus, JPEG under 200 KB; print the result headers
curl -sS -D - -o square.jpg \
  -F "file=@photo.jpg" \
  -F 'options={"resize":{"width":1080,"height":1080,"fit":"cover","position":"attention"},"format":"jpeg","targetSizeBytes":204800}' \
  https://resizer.example.com/api/v1/images/process | grep -i '^x-'

# Rotate, mirror, then crop in the rotated frame
curl -sS -o out.png -F "file=@scan.tiff" \
  -F 'options={"rotate":90,"flipH":true,"crop":{"left":100,"top":80,"width":800,"height":600},"format":"png"}' \
  https://resizer.example.com/api/v1/images/process
```

```ts
// Browser (same origin)
const form = new FormData();
form.append('options', JSON.stringify({ resize: { width: 1600 }, format: 'avif', quality: 60 }));
form.append('file', file);
const res = await fetch('/api/v1/images/process', { method: 'POST', body: form });
if (!res.ok) throw new Error((await res.json()).title);
const blob = await res.blob();
```

## Errors

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
document with `Content-Type: application/problem+json` and `Cache-Control: no-store`:

```json
{
  "type": "urn:image-resizer:problem:validation_failed",
  "title": "One or more processing options are invalid.",
  "status": 422,
  "code": "validation_failed",
  "errors": [{ "path": "resize.width", "message": "Too big: expected number to be <=10000" }],
  "requestId": "0d7c4f7e-5b7a-4b8e-9d7e-3a1d7f3c9b21"
}
```

`title` is safe to show to end users. Branch on `code`, which is stable.
Internal errors never include stack traces or internal messages.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `file_required` | No `file` part. |
| 400 | `invalid_upload` | More than one file, wrong field name, or the multipart structure exceeds its limits. |
| 400 | `invalid_options` | `options` is not valid JSON or is over 4 KB. |
| 403 | `forbidden` | Origin secret missing or wrong (direct origin access). |
| 403 | `origin_not_allowed` | CORS preflight from an origin not in `CORS_ORIGINS`. |
| 404 | `not_found` | Unknown route. |
| 413 | `file_too_large` | Upload over `MAX_UPLOAD_MB`. |
| 413 | `image_too_large` | Decoded pixel count over `MAX_INPUT_PIXELS` (the decompression-bomb guard). |
| 415 | `unsupported_media_type` | Content is not an allowlisted image (SVG, HEIC, PDF, executables, …). |
| 422 | `validation_failed` | Options fail the schema; `errors[]` lists each field. |
| 422 | `invalid_image` | Corrupt or truncated image data. |
| 422 | `crop_out_of_bounds` | The crop exceeds the transformed image. |
| 422 | `output_too_large` | The resulting size would exceed `MAX_OUTPUT_DIMENSION` / `MAX_OUTPUT_PIXELS`. |
| 429 | `rate_limited` | Per-client limit exceeded; see `Retry-After` and `RateLimit-*`. |
| 500 | `internal_error` | Unexpected failure; quote `requestId` when reporting it. |
| 503 | `server_busy` | Processing queue full; retry after `Retry-After`. |
| 503 | `processing_timeout` | Over `PROCESSING_TIMEOUT_SECONDS`; try smaller dimensions or a larger budget. |

## `GET /capabilities`

Cacheable for 5 minutes. The SPA reads its limits from here.

```json
{
  "maxUploadBytes": 26214400,
  "maxInputPixels": 50000000,
  "maxOutputDimension": 10000,
  "maxOutputPixels": 50000000,
  "inputFormats": ["jpeg", "png", "webp", "gif", "tiff", "avif"],
  "outputFormats": ["jpeg", "png", "webp", "avif"],
  "fitModes": ["cover", "contain", "fill", "inside", "outside"],
  "positions": ["center", "attention", "entropy"],
  "targetSize": { "minBytes": 1024, "maxBytes": 209715200 }
}
```

## Feedback

### `GET /feedback`

Powers the scrolling review section. Returns `{ "enabled": false }` when an
admin has hidden the wall; the client then renders nothing. Cached for 30 s
(server and browser).

```json
{
  "enabled": true,
  "summary": { "average": 4.6, "count": 128, "distribution": { "1": 2, "2": 3, "3": 6, "4": 25, "5": 92 } },
  "items": [
    { "id": "mg3k2x8a0c1d2e3f4a5b6", "rating": 5, "comment": "Hit the exact file size for my visa photo.", "name": "Asha", "createdAt": "2026-09-28T04:12:00.000Z" }
  ]
}
```

`summary` covers **every** rating, including rating-only submissions and hidden
comments; deleting a review removes its rating. `items` holds up to 40 of the
newest **published** comments. Rating-only submissions count towards the
average but are not listed.

### `POST /feedback`

`application/json`, at most 4 KB. Rate limited to `FEEDBACK_RATE_LIMIT_MAX` per
client IP per hour (default 5).

| Field | Type | Rules |
| --- | --- | --- |
| `rating` | integer | Required, 1–5. |
| `comment` | string | Optional, ≤ 500 characters after cleaning. |
| `name` | string | Optional, ≤ 40 characters after cleaning. Shown publicly; blank means "Anonymous". |
| `website` | string | Honeypot. Leave it empty; submissions that fill it are silently discarded. |

Text is NFC-normalised, invisible and bidirectional-override characters are
removed, and whitespace is collapsed. Unknown fields are rejected (`422`).

`201 { "received": true, "status": "published" | "pending" }`. The status is
`pending` when `FEEDBACK_MODERATION=manual`, or when the text contains a link,
email address or phone number. Pending comments appear only after approval in
`/admin`.

## Admin API

Mounted only when both `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` are
set; otherwise every `/admin/*` route returns `404`. All responses are
`Cache-Control: no-store`. The browser UI lives at `/admin`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `POST` | `/admin/login` | `{ "password": "…" }` | `200` + session cookie, or `401 invalid_credentials`. At most 10 failed attempts per 15 min per IP (`429`). |
| `POST` | `/admin/logout` | – | Clears the cookie. |
| `GET` | `/admin/session` | – | `{ "authenticated": boolean }` |
| `GET` | `/admin/overview` | – | `{ settings: { wallEnabled }, summary, counts: { published, pending, hidden } }` |
| `GET` | `/admin/feedback?status=published\|pending\|hidden&limit=1-100&cursor=…` | – | `{ items: [...], nextCursor? }`, newest first. |
| `PATCH` | `/admin/feedback/{id}` | `{ "status": "published" \| "pending" \| "hidden" }` | The updated review. Hiding keeps the rating in the average. |
| `DELETE` | `/admin/feedback/{id}` | – | `204`; the rating is also removed from the average. |
| `PUT` | `/admin/settings` | `{ "wallEnabled": boolean }` | Shows or hides the whole review wall. |

**Session.** An HMAC-SHA256 signed token (`ADMIN_SESSION_HOURS`, default 8 h)
in an `HttpOnly`, `SameSite=Strict` cookie, named `__Host-ir_admin` and `Secure`
in production.

**CSRF.** `SameSite=Strict`, JSON-only bodies (a cross-site JSON request needs a
CORS preflight, which is never granted for `/admin`), and rejection of any
request whose `Sec-Fetch-Site` is `cross-site` or `same-site`.

Protected routes return `401 unauthorized` without a valid session.

## `GET /health` and `GET /ready`

Both are exempt from origin verification, so the load balancer can probe them.

```json
// GET /health → 200
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 5231 }

// GET /ready → 200, or 503 while the processing queue is full
{ "status": "ready", "active": 1, "queued": 0, "concurrency": 2 }
```

## Cross-cutting behaviour

- **Rate limiting.** `POST /images/process` is limited to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_SECONDS` per client IP (defaults 30/60 s), counted per instance. Headers follow IETF draft-8 (`RateLimit`, `RateLimit-Policy`). The client IP comes from `X-Forwarded-For` only across `TRUST_PROXY` trusted hops.
- **CORS.** Off by default, since production is same-origin. When `CORS_ORIGINS` is set, only those exact origins are reflected; there is no wildcard mode and credentials are never allowed.
- **Origin verification.** With `ORIGIN_VERIFY_SECRET` set, every route except `/health` and `/ready` requires `X-Origin-Verify` (constant-time comparison). CloudFront adds this header; browsers never see it.
- **Request IDs.** An inbound `X-Request-Id` matching `^[\w-]{8,64}$` is propagated; otherwise a UUID is generated. It is echoed on every response and in problem bodies.
- **Security headers.** API responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, and HSTS in production.
