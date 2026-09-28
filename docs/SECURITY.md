# Security

This page maps each threat to the control that addresses it and where that
control lives. Use it when reviewing changes that touch uploads, headers,
configuration or infrastructure.

## Reporting a vulnerability

Please report privately to the maintainers, not in a public issue. Include
the `requestId` from any error response you observed.

## Threat model

The service accepts **untrusted binary files from anonymous users** and runs
a native image decoder on them. The main risks are decoder exploitation,
resource exhaustion, data leakage between users, and misconfiguration.

| Threat | Controls | Where |
| --- | --- | --- |
| **Malicious file masquerading as an image** (script, HTML, polyglot) | Declared MIME and filename are ignored. Magic-byte sniffing against an allowlist (JPEG, PNG, WebP, GIF, TIFF, AVIF), cross-checked against the decoder's own detection. | `services/imageSniffer.ts`, `imageProcessor.ts` |
| **SVG / XML attacks** (script, XXE, external fetches) | SVG is never accepted as input, so librsvg is unreachable. | `imageSniffer.ts` |
| **Decoder exploits** | libvips via sharp (memory-safe loaders, actively patched, no shell-out). Weekly Dependabot updates. `failOn: 'error'` aborts on corrupt data. The process is sandboxed by systemd (see below). | `imageProcessor.ts`, `image-resizer.service` |
| **Decompression bombs** | `limitInputPixels` (default 50 MP) is enforced from the header before decode. Predicted output size is checked against `MAX_OUTPUT_DIMENSION` / `MAX_OUTPUT_PIXELS` before any pixels are allocated. Channel limit is 5. | `imageProcessor.ts`, `geometry.ts` |
| **Oversized uploads** | nginx `client_max_body_size`, then multer `fileSize`, 1 file, 2 fields, 8 KB field size, 3 parts, 50 header pairs. | `nginx.conf`, `middleware/upload.ts` |
| **Path traversal via filename** | Uploads are always written as `<random mkdtemp dir>/input`. The client filename is only used, sanitised to `[\w\- ]` and split on both separators, for the download name. | `middleware/upload.ts` |
| **Upload left on disk / cross-user leakage** | Per-request `0700` workspace deleted on response `close`, janitor sweep, purge on boot, systemd `PrivateTmp`. Outputs never touch disk. The libvips cache is disabled so no pixels outlive a request. | `services/tempStore.ts`, [system design](SYSTEM_DESIGN.md#temporary-file-lifecycle) |
| **Metadata privacy** (GPS, camera serials, author) | All EXIF/XMP/IPTC/ICC is stripped from every output (tested). | `imageProcessor.ts`, `imageProcessor.test.ts` |
| **Invalid or hostile options** | Strict zod schema (unknown keys rejected, integer-only pixels, enums, hex-only colours, 4 KB cap). Crop is validated against the real transformed bounds. | `services/processOptions.ts` |
| **CPU/memory exhaustion (DoS)** | Per-IP rate limit, concurrency semaphore with a bounded queue (503 + `Retry-After`), sharp timeouts, a deadline on the budget search, header/request timeouts, systemd `MemoryMax` and `TasksMax`, WAF rate rule at the edge. | `routes/api.ts`, `lib/semaphore.ts`, `index.ts` |
| **Slow-loris / slow uploads** | `headersTimeout` 15 s, `requestTimeout` 120 s; nginx buffers request bodies. | `index.ts`, `nginx.conf` |
| **IP spoofing to evade rate limits** | `TRUST_PROXY` must be a hop count or subnet list. `true` is rejected at boot. | `config/env.ts` |
| **Bypassing CDN/WAF by hitting the origin** | ALB security group admits only the CloudFront prefix list, plus the `X-Origin-Verify` shared secret with constant-time comparison and zero-downtime rotation. | `compute.yaml`, `middleware/security.ts` |
| **XSS / clickjacking in the SPA** | CSP `default-src 'self'` with no `unsafe-inline`/`unsafe-eval`, `frame-ancestors 'none'`, no `dangerouslySetInnerHTML`, React escaping. Same headers from Helmet (self-hosted) or the CloudFront response-headers policy. e2e asserts zero CSP violations. | `middleware/security.ts`, `edge.yaml` |
| **Cross-origin abuse** | No CORS by default (same origin). An allowlist of exact origins only; no wildcard; no credentials. | `middleware/security.ts` |
| **Information disclosure in errors** | RFC 9457 problems with fixed messages. Internal errors are logged server-side with a request ID; clients see a generic message. `x-powered-by` is disabled; `server_tokens off`. | `middleware/errors.ts` |
| **Sensitive data in logs** | Only method, URL, status and timings are logged. Filenames and bytes are never logged. `authorization`, `cookie` and `x-origin-verify` are redacted. | `lib/logger.ts`, `app.ts` |
| **Transport security** | HTTPS end to end (viewer → CloudFront → ALB with TLS 1.2+, or → nginx with Let's Encrypt on the single server), HSTS preload, S3 bucket policies deny non-TLS. | `edge.yaml`, `compute.yaml`, `single-server.yaml` |

### Feedback and the admin area

| Threat | Controls | Where |
| --- | --- | --- |
| **Stored XSS through reviews** | Comments are rendered as React text nodes and never as HTML. A strict CSP forbids inline script anyway. | `ReviewWall.tsx`, CSP |
| **Spoofed or hidden text** (bidi overrides, zero-width characters, "Trojan Source") | NFC normalisation and removal of control, zero-width and bidi characters before storage. The filter is built from numeric code-point ranges, so the source file itself contains no invisible characters, and a CI-style scan confirms the whole repo has none. | `feedback/sanitize.ts` |
| **Spam and scam links on the review wall** | Comments with URLs, emails or phone numbers are held as `pending` even in `auto` mode. Also: honeypot field, per-IP rate limit (5/hour), 4 KB body cap, strict schema. | `feedback/service.ts`, `routes/feedback.ts` |
| **Admin password theft or guessing** | Only an scrypt hash (N=2¹⁵, r=8, p=1, 16-byte salt) is configured; the password itself is stored nowhere. Constant-time comparison. 10 failed attempts per 15 min per IP. Minimum 12 characters. | `adminAuth.ts`, `routes/admin.ts` |
| **Session hijacking** | HMAC-SHA256 signed, expiring token in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` prefix and `Secure` in production). Rotating `ADMIN_SESSION_SECRET` signs everyone out. | `adminAuth.ts` |
| **CSRF against admin actions** | `SameSite=Strict`, JSON-only bodies (a cross-site request would need a CORS preflight, which `/admin` never grants), and rejection of `Sec-Fetch-Site: cross-site/same-site`. | `routes/admin.ts` |
| **Admin area discovery** | It returns `404` unless configured, is `noindex` and disallowed in `robots.txt`, and its code is a separate chunk that visitors never download. | `app.ts`, `AdminApp.tsx`, `robots.txt` |
| **Forged pagination cursors** | Cursors are validated for shape and status before reaching DynamoDB. | `dynamoStore.ts` |
| **Data loss or tampering** | The instance role can reach only this table (no Scan, no table admin). Point-in-time recovery for 35 days, deletion protection, `Retain` on stack deletion. | `single-server.yaml`, `compute.yaml` |
| **Privacy** | No IP addresses or identifiers are stored with reviews. The name is optional and the form says the review is public. Local-development data (`.data/`) is gitignored. | `service.ts`, `FeedbackForm.tsx`, `.gitignore` |
| **Certificate automation abused** | The single server's role may change only the `_acme-challenge.origin.<domain>` TXT record (IAM condition keys on record name, type and action). | `single-server.yaml` |

## Environment and secret management

1. **Nothing secret is committed.** `.gitignore` excludes `.env`, `.env.*` (except `*.example`), keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`, …), cloud credentials (`.aws/`, `credentials*.json`), Terraform state, build output, logs and upload/temp directories. Check with `git check-ignore -v server/.env`.
2. **Templates, not values.** [`server/.env.example`](../server/.env.example) and [`client/.env.example`](../client/.env.example) document every variable with safe defaults.
3. **Validated at boot.** [`config/env.ts`](../server/src/config/env.ts) parses all variables with zod. Invalid values stop the process, and the error names the variable but **never prints its value**. Unsafe settings are refused: `TRUST_PROXY=true`, CORS wildcards or paths, origin secrets under 32 characters, `TEMP_DIR=/`.
4. **Production secrets live in AWS.** They are SSM Parameter Store `SecureString`s under `/image-resizer/prod`. Instances read only that path (IAM-scoped) and render them to a `0640 root:image-resizer` env file. Secrets never appear in the AMI, the release tarball, user-data or GitHub.
5. **No CI credentials.** GitHub Actions uses OIDC to assume a deploy role that is limited to one repository environment and to the exact buckets, distribution and tagged instances it needs.
6. **Build-time variables are public.** Every `VITE_*` value is compiled into the JavaScript bundle; the template says so explicitly.
7. **Release packaging refuses secrets.** `package-release.sh` aborts if the staged release contains `.env`, `*.pem` or `*.key` files.

## Supply chain

- **Lockfile and install.** Committed `package-lock.json`, with `npm ci` everywhere. `save-exact` and `engine-strict` are set in `.npmrc`.
- **Audits.** `npm audit --omit=dev --audit-level=high` fails CI and deploys.
- **No install scripts in production.** Production installs use `--ignore-scripts`, so dependency lifecycle hooks never run on servers.
- **Pinned actions.** GitHub Actions are pinned to full commit SHAs (verified against their tags), and Dependabot keeps both npm packages and actions current.
- **Verified tool downloads.** gitleaks (CI), Node.js (instances) and each release tarball are all verified against SHA-256 checksums before use.
- **Scanning.** gitleaks scans the full git history. CodeQL `security-extended` runs on every PR.
- **Known dev-tool note.** ESLint is held at v9 because `eslint-plugin-jsx-a11y` does not yet support v10. This is dev-only and not shipped.

## Host hardening (EC2)

- Private subnets, no public IP, no SSH, no key pairs. Access is through SSM Session Manager and is audited in CloudTrail.
- IMDSv2 required with hop limit 1, which blocks SSRF-style credential theft from containers or proxies. EBS is encrypted.
- The instance role can read only its release prefix and its SSM path.
- The service runs as the unprivileged `image-resizer` user. Its code is owned by root and read-only to the service.
- systemd sandbox: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, an empty capability set, `RestrictAddressFamilies`, `SystemCallFilter=@system-service`, `MemoryMax=80%`, `UMask=0077`.
- Node binds to `127.0.0.1` only, behind nginx.

## Security testing

Automated tests cover the following:

- SVG, HTML and executables disguised as images → 415
- truncated and garbage images → 422
- pixel bombs → 413
- traversal filenames → sanitised
- more than one file or unexpected fields → 400
- oversized uploads → 413, with the temp directory still cleaned up
- rate limiting → 429 with standard headers
- CORS allow and deny
- origin secret required, wrong and rotated
- malformed request IDs not reflected
- dotfiles not served
- metadata stripped from output
- the temp directory is empty after every response, both in integration tests and after the full e2e run

## Pre-release checklist

- [ ] `npm run check` and `npm run test:e2e` pass; CI is green, including gitleaks and CodeQL.
- [ ] `npm run audit:prod` is clean.
- [ ] No new `VITE_*` variables carry sensitive values.
- [ ] New request fields are covered by the strict schema and have negative tests.
- [ ] New response headers are added to `EXPOSED_HEADERS` only if the client needs them.
- [ ] Infra changes pass `cfn-lint`, ShellCheck and actionlint.
