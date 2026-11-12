# Support

Where to take each kind of question, and what to expect.

## Questions and ideas

Usage questions, configuration help, and design proposals go to
[Discussions](https://github.com/abillify/atf/discussions). Open an issue only for a
reproducible defect or a concrete, well-scoped feature request — the issue templates
route both.

## Bugs

Search [existing issues](https://github.com/abillify/atf/issues) first. Include the
version (`bun run verify:version` prints the expected one for a checkout; each service
reports it on its health endpoint), the flow or tool configuration involved with
secrets removed, and the exact error text. Reproducible reports get a response faster
than descriptions of intent.

## Security vulnerabilities

Never open a public issue. Report privately through
[GitHub security advisories](https://github.com/abillify/atf/security/advisories/new).
Scope, response targets, and disclosure handling are in [SECURITY.md](SECURITY.md).

## Commercial support and licensing

Managed hosting, SaaS, OEM, or white-label use — anything beyond what the Elastic
License 2.0 already permits — is handled at <licensing@abillify.me>. See
[LICENSING.md](LICENSING.md) for what needs no agreement.

## What support looks like today

ATF is maintained by a small team at Abillify Technology GmbH
(see [AUTHORS.md](AUTHORS.md) and [GOVERNANCE.md](GOVERNANCE.md)). There is no
support SLA: responses happen in public on GitHub during normal development, and
the release cadence is announced in [CHANGELOG.md](CHANGELOG.md). Production
deployments should plan around the stability contract in
[docs/STABILITY.md](docs/STABILITY.md) and the runbooks in [docs/runbooks/](docs/runbooks/)
rather than around response times.
