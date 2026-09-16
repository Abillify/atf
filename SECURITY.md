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
| Tagged releases, including `v0.5.0` | Only through the next tag |

## Scope

In scope: authentication and authorization bypass, tenant isolation escape, SQL or command
injection, prompt injection that escalates to tool execution or data access beyond the
caller's scope, PII vault leakage, audit log forgery, approval gate bypass, SSRF through tool,
provider, or conversion-callback configuration, escape from the document conversion path,
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

## Contributing securely

Never commit secrets, real endpoints, production flows, customer data, or internal
assessments. `.env.example` files contain placeholders only.

Run `bun run verify:public` before sharing or pushing a tree. The tag-release workflow runs the
same verifier with `--require-rules` against the exact tag commit and requires the confidential
`ATF_REDACTION_RULES_JSON` repository Actions secret, so missing rules or literal matches block
publication.
