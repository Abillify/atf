# Licensing

## Current status

ATF is **source-available** under the [Elastic License 2.0](LICENSE)
(SPDX: `Elastic-2.0`). Every workspace in this repository declares
`"license": "Elastic-2.0"`.

ATF is **not** open source as defined by the Open Source Initiative, and this project does
not describe itself as open source. It is fair-code: the source is public, most use is
free, and a small set of commercial uses is reserved to the licensor.

## What you may do

| Use | Allowed under Elastic-2.0 | Notes |
| --- | --- | --- |
| Run ATF for your own business, internal or production | Yes | No fee, no registration, no usage reporting |
| Self-host for your own users and customers | Yes | Including customer-facing applications you operate |
| Modify the source | Yes | Modified copies must state prominently that they were modified |
| Redistribute source or binaries | Yes | Recipients must also receive the license terms |
| Fork publicly | Yes | The fork stays under Elastic-2.0 |
| Build and sell a product that embeds ATF | Yes | As long as you are not reselling ATF itself as a hosted service |
| Personal, research, and educational use | Yes | |
| Offer ATF to third parties as a hosted or managed service | **No** | This is the reserved commercial use; requires a commercial license |
| Remove or obscure licensing and copyright notices | **No** | |
| Circumvent license-key functionality | **No** | Currently inert: ATF ships no license-key enforcement |
| Use the ATF or Aiperator marks for your distribution | **No** | Trademarks are separate; see [TRADEMARKS.md](TRADEMARKS.md) |

The hosted-service limitation is narrow. It targets offering ATF's own feature set to third
parties as a service. Operating ATF to power your own product, where the value your users
buy is your product rather than access to ATF's features, is permitted. If your case is
genuinely ambiguous, ask rather than guess: <licensing@abillify.me>.

The license-key clause in Elastic License 2.0 has no effect today because ATF contains no
license-key gating. It is retained because the license text is used verbatim; removing
clauses would create a non-standard license and defeat the point of using a recognized one.

## Commercial license

A separate commercial agreement with Abillify Technology GmbH can authorize offering ATF's
substantial feature set to third parties as a hosted or managed service, which Elastic-2.0
reserves. Separate commercial terms may also cover distinct matters that are not the
hosted-service restriction itself:

- permission to use ATF or Aiperator trademarks in an OEM or white-label offering;
- redistribution under proprietary or other terms instead of Elastic-2.0; and
- support, service levels, indemnification, or warranties that Elastic-2.0 does not provide.

An OEM or white-label architecture is not automatically prohibited merely because of that
label; the hosted-service facts, redistribution terms, and trademark permissions must each be
assessed separately. Contact <licensing@abillify.me>.

## Why Elastic License 2.0

Considered alternatives and the reason each was not chosen:

| Option | Why not |
| --- | --- |
| Apache-2.0 or another OSI license | No protection against a third party reselling ATF as a hosted service, which is the one commercial risk that matters for this project |
| AGPL-3.0 | Copyleft reach into operator systems deters the regulated-industry deployments ATF targets, and it does not actually prevent hosted resale |
| Business Source License 1.1 | Requires choosing an Additional Use Grant and a change date, and the eventual relicensing commitment is a decision this project is not ready to make |
| n8n Sustainable Use License | Bespoke text without an SPDX identifier, which makes package metadata, SBOM generation, and per-file headers awkward, and it restricts commercial use more broadly than necessary |
| Server Side Public License | Widely rejected by downstream distributors and packagers; the reputational cost outweighs the marginal protection |

Elastic License 2.0 was chosen because it is short and readable, is registered with SPDX as
`Elastic-2.0` so tooling handles it natively, is explicitly published for reuse by other
projects, and primarily reserves offering the software's substantial feature set to third
parties as a hosted or managed service. Trademark permission for ATF or Aiperator-branded OEM
and white-label offerings is a separate question governed by [TRADEMARKS.md](TRADEMARKS.md).
Redistribution under terms other than Elastic-2.0 likewise requires a separate license from
Abillify; it is not itself the hosted-service restriction.

## Contributions

External contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the process.
Before contributing, an individual or legal entity must separately execute the
[ATF Contributor Copyright Assignment Agreement 1.0](CONTRIBUTOR_ASSIGNMENT_AGREEMENT.md).
Every commit must document coverage by that existing Agreement with this exact trailer:

```text
ATF-Contributor-Assignment-Accepted: 1.0, Full Name <name@example.com>
```

The trailer does not execute the Agreement or replace any required formality. Subject to
mandatory law, accepted Contributions are assigned to Abillify Technology GmbH; where copyright
cannot be assigned, Abillify receives exclusive, worldwide exploitation rights. This permits
free commercial relicensing and proprietary, Elastic-, dual-, or multi-license distribution,
including SaaS, managed-service, OEM, and white-label models. Mandatory inalienable rights and
identified third-party ownership, terms, and notices remain unaffected. Contributors receive the
Agreement's Elastic-2.0 license back to their own Contributions.

## Third-party dependencies

Dependency licenses are inventoried in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[sbom.cdx.json](sbom.cdx.json), both generated by `bun run supply-chain`.

`bun run supply-chain:check` is fail-closed. It tokenizes and parses each declared SPDX expression
using only license identifiers, parentheses, `AND`, and `OR`; `LicenseRef`, `WITH`, free-form
names, unknown identifiers, malformed syntax, and missing assertions are rejected. After
canonicalization, the complete expression must be exactly one entry of the allowlist
(`ALLOWED_LICENSE_EXPRESSIONS` in `scripts/generate-supply-chain.ts` is authoritative; an
expression not on it fails the check, however permissive its parts are):
- single identifiers: `Apache-2.0`, `MIT`, `MIT-0`, `0BSD`, `ISC`, `BSD-2-Clause`,
  `BSD-3-Clause`, `MPL-2.0`, `LGPL-3.0-or-later`, `CC-BY-4.0`, `BlueOak-1.0.0`, `CC0-1.0`
  (both only from jsdom, a test dependency of Control), and, from the Rust dependency
  graph of Outpost Desktop, `Zlib`, `Unicode-3.0`, `Unlicense` and `CDLA-Permissive-2.0`;
- combinations: `MIT AND ISC`, `MIT OR Apache-2.0` (either operand order),
  `(AFL-2.1 OR BSD-3-Clause)`, `(MIT OR CC0-1.0)`, plus the dual and triple licenses and the
  `Unicode-3.0` pairing found in that Rust graph (for example `Apache-2.0 AND MIT`,
  `0BSD OR MIT OR Apache-2.0`, `Unlicense OR MIT`, `(MIT OR Apache-2.0) AND Unicode-3.0`).
  Adding a package whose expression is not listed means adding that exact expression, with a
  matching license text, in a reviewed change.

The canonical expression is used for policy evaluation and SBOM output. The denylist improves
error diagnostics only; it cannot make an expression allowable. Every license identifier named in
an accepted expression must resolve to its own plausibly complete matching text, including all
`AND` and `OR` branches. MIT, MIT-0, 0BSD, ISC, AFL-2.1, CC0-1.0, and the other allowed families
have separate signatures, so MIT cannot satisfy MIT-0. Package files are preferred; narrowly
reviewed package/version/license/repository-bound rules and vendored authoritative texts cover
only documented omissions in `licenses/README.md`. The canonical Apache License 2.0 text is
hash-guarded, while package-specific Apache `NOTICE` files remain separate.

Artifact-specific entries make allowed LGPL, MPL, and CC-BY duties visible: libvips is a
dynamically loaded replaceable shared library; MPL remains file-scoped and requires covered
source availability; and caniuse-lite carries its CC-BY attribution link and modification status.
These classifications apply to the inventoried workspace or Quickstart image only and are not a
blanket compliance statement for independently built production images.

Container images additionally ship OS packages from their base distributions — notably poppler
(GPL-2.0-or-later/MPL-2.0) and LibreOffice (MPL-2.0/LGPL-3.0-or-later) in the extract image.
Those tools run as separate processes invoked via `execFile`, which keeps them outside ATF's
derivative-work boundary; their license and source-availability duties, and the per-image Trivy
license SBOMs attached to each release, are documented in
[docs/IMAGE-LICENSES.md](docs/IMAGE-LICENSES.md).

## Changing this license

Any future license change requires:

1. confirmation that Abillify Technology GmbH owns or has sufficient exclusive rights to every
   contribution included at that point, and identification of any mandatory contributor rights
   or third-party material that constrains the proposed terms;
2. legal review of the new terms, warranty and patent language, privacy implications, export
   controls, and third-party obligations;
3. confirmation that the executed Contributor Assignment Agreements and corporate schedules
   cover the relevant Contributions and identities;
4. a coordinated update of `LICENSE`, `LICENSE.md`, this document, all package metadata,
   per-file SPDX headers, the SBOM, contribution terms, and any customer agreements;
5. release-gate verification on the exact release commit: public-tree check, secret-history
   check, third-party notices, SBOM, license policy, tests, and build.

A change will be announced in advance and will not retroactively remove rights already
granted for released versions.
