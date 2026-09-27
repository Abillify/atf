# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through either channel:

- GitHub private vulnerability reporting: use the **Report a vulnerability** button under the
  repository's Security tab. Preferred, because it keeps the report, the fix, and the advisory
  together.
- Email: <security@abillify.me>.

Please include:

- affected component (`runtime`, `control`, `search`, `gate`, `extract`, or a contract package)
  and version or commit;
- impact and the attacker capability required;
- reproduction steps or a minimal proof of concept;
- relevant configuration, since many behaviors are configuration-dependent.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | 3 working days |
| Initial assessment and severity | 10 working days |
| Fix or documented mitigation for critical and high severity | 30 days from assessment |
| Coordinated public disclosure | After a fix is available, by agreement with you |

If we cannot meet a target we will say so rather than go silent. We will credit you in the
advisory unless you prefer otherwise.

Please give us a reasonable window before publishing. We will not pursue legal action over
good-faith research that respects these terms and does not involve third-party systems, data
belonging to others, denial of service, or social engineering.

There is no bug bounty program.

## Supported versions

ATF is pre-1.0. Only the latest commit on `main` receives security fixes. Tags mark releases
but are not maintained branches: a fix ships on `main` and in the next tag, never as a patch to
an earlier one. This table will gain rows if that changes.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Tagged releases, including `v0.8.0` | Only through the next tag |

## Scope

In scope: authentication and authorization bypass, tenant isolation escape, SQL or command
injection, prompt injection that escalates to tool execution or data access beyond the
caller's scope, PII vault leakage, audit log forgery, approval gate bypass, SSRF through tool,
provider, conversion-callback, or `source_url` configuration, escape from the document
conversion path,
secret disclosure, and privilege escalation in the operator plane.

Out of scope: findings that only apply to `deploy/examples`, which is documented as an
unauthenticated local stack and is not a production template; missing hardening in a
configuration the documentation already warns against; vulnerabilities in third-party
dependencies without a demonstrated path through ATF (report those upstream, and tell us so we
can bump); and results from automated scanners without a demonstrated impact.

## Deployment security

ATF provides production-readiness gates and multiple fail-closed controls, but individual
features and fail modes remain configuration-dependent. Runtime refuses to start under selected
unsafe settings when `APP_ENV=production`, for example open CORS, unverified JWTs, or an
unauthenticated monitoring endpoint. Treat that gate as a safety net, not as a substitute for
the review described in [DEPLOYMENT.md](DEPLOYMENT.md).

### Extract v2 source intake (resumable upload and `source_url`)

The v2 ingestion path accepts document sources two ways, and both are treated as untrusted
input under authentication and the `extract.ingest` scope.

**Resumable, content-addressed upload (`/v2/uploads`).** Bytes are never buffered whole: each
chunk is streamed straight to a scratch file and its per-chunk sha256 (when the client supplies
`X-Chunk-Checksum-Sha256`) is verified before the confirmed offset advances. A wrong
`Upload-Offset` is refused with `409` carrying the true offset, so a chunk can never be written
to the wrong place, and a failed chunk is truncated away so a re-send behaves as if it never
happened. On `complete`, the whole-file sha256 is verified before the assembled file is moved
into the content-addressed source store; a mismatch reopens the session rather than storing
corrupt bytes. `MAX_UPLOAD_BYTES` bounds the total. Session state lives in the `extract` schema,
so the checks hold across process restarts and replicas.

**`source_url` pull (SSRF controls).** Pulling a caller-supplied URL is the same server-side
request forgery primitive as the conversion callback (`X-Callback-URL`), and it reuses those
controls rather than inventing a second set:

- Link-local and cloud-metadata addresses are refused unconditionally.
- `SOURCE_URL_ALLOWED_HOSTS`, when set, is an allowlist (with the same `.example.com`-matches-
  subdomains rule as the callback allowlist). Left unset it permits any non-forbidden host, and
  the production-readiness gate flags the empty list.
- Only `http`/`https` schemes are accepted, URLs carrying credentials are rejected, and
  redirects are followed manually up to a small bound with **every hop re-validated**, so a
  permitted host cannot `302` the request onto a forbidden one.
- The body streams into the source store while `SOURCE_URL_MAX_BYTES` is enforced, and
  `SOURCE_URL_TIMEOUT_MS` bounds each request, so a hostile or oversized target cannot exhaust
  memory or hang the pull.

Escape from the document conversion path and SSRF through the conversion configuration are both
explicitly in scope (see below); the `source_url` allowlist and the upload checksum chain are
the controls a deployment must configure and monitor.

## Contributing securely

Never commit secrets, real endpoints, production flows, customer data, or internal
assessments. `.env.example` files contain placeholders only.

Run `bun run verify:public` before sharing or pushing a tree. The tag-release workflow runs the
same verifier with `--require-rules` against the exact tag commit and requires the confidential
`ATF_REDACTION_RULES_JSON` repository Actions secret, so missing rules or literal matches block
publication.
