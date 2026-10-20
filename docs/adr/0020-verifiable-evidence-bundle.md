# 20. Verifiable Evidence Bundle

Date: 2026-08-02

## Status

Accepted — the HMAC-only signing and the rejection of asymmetric keys are
partially superseded by
[ADR-0030](0030-asymmetric-evidence-chain-ed25519.md); HMAC bundles remain
verifiable as legacy artefacts

## Context

ADR-0017 gave the platform a Decision-Provenance Explainability Card — one
synthesized artefact answering "why did the agent answer this way", assembled
on demand from execution history, the debug trace overlay, the PII vault's
action summary, and the audit log. As plain JSON or Markdown, though, it is
just a claim: an operator downloading it, or the platform itself generating
it for a customer or a regulator, has no way to prove afterwards that the file
handed over is the same one the platform produced. Anyone in the handling
chain could edit a number before forwarding it, and the artefact carries no
evidence of that.

The platform already solved an adjacent problem — proving a durable audit log
has not been retroactively edited — with `audit-anchor.ts`'s periodic
HMAC-SHA256 signature over the chain's current hash, checked outside the
database. That is the right shape of guarantee for this artefact too: not
"this fact is true" (the card can only ever attest to what the platform's
stores reported at generation time), but "this artefact's content is exactly
what the signing party produced, unaltered since".

## Decision

`src/observability/evidence-bundle.ts` wraps an already-built `ExplainCard`
into a `SignedEvidenceBundle`: a SHA-256 content hash over the bundle's
canonical serialization, and an HMAC-SHA256 signature over that hash — the
same `algorithm: "hmac-sha256"` shape `audit-anchor.ts` already uses, reusing
its primitive rather than introducing a new one (asymmetric signing was
considered and rejected: it would need a key-management/distribution story
disproportionate to what this feature needs).

**Canonicalization.** The content hash is computed over a recursively
key-sorted JSON serialization (`canonicalizeForBundleHash`), not a plain
`JSON.stringify` — the hash is a security property, not an implementation
detail, and must not silently change if a future refactor reorders how the
card's fields are assembled. Array order is preserved (arrays are ordered
data — the steps list's order is meaningful; objects are not).

**Route.** `GET /monitoring/explain/:executionId/bundle` (+ `?format=markdown`
for a downloadable artefact, matching the plain card's own format switch)
builds the card exactly as the existing route does, then signs it. When
`AuditAnchorService` is active, the bundle also embeds the anchor's current
`AuditAnchorStatus` — a reader gets that chain's own tamper-evidence bundled
into the one signed artefact, instead of a second thing to separately fetch
and trust.

**Secret.** `EVIDENCE_BUNDLE_SECRET` falls back to `AUDIT_ANCHOR_SECRET` when
unset. Both use the identical HMAC primitive, and a deployment that already
anchors its audit chain should not need to provision and rotate a second
secret for a closely related guarantee. The route returns `404` (not `503`)
when neither is configured — the same "feature not enabled" pattern other
optional capabilities in the codebase already use (e.g. BYOK's `404` in
`tenants.ts`), rather than treating an intentionally-disabled feature as a
service outage.

**Offline verification.** `verifyEvidenceBundle()` recomputes the content hash
from the embedded bundle and checks both the hash and the signature — this
is the exact function `scripts/cli.ts verify-bundle <bundle.json> --secret
<secret>` calls. The CLI command makes no network request: only the bundle
file and the shared secret are needed, so a recipient can verify authenticity
without trusting, or even being able to reach, the server that issued it.

**Frontend.** The dashboard's **Explain** tab (`ExplainCard.tsx`) gains a
second download button, "Download Evidence Bundle" (JSON), alongside the
existing "Download Markdown" export of the plain card — both use the same
authenticated-fetch-to-Blob download pattern already established for the
Markdown export.

## Consequences

- **Positive.** No new cryptographic primitive, key-management story, or PKI
  — a deployment already familiar with `AUDIT_ANCHOR_SECRET` has nothing new
  to learn. Zero new hot-path writes: the bundle is built and signed entirely
  on-demand from the same read-only aggregation ADR-0017 already performs.
  Fully backward compatible with the existing `/monitoring/explain/:executionId`
  route, which is untouched.
- **Negative / residual.** The guarantee is integrity, not accuracy: a signed
  bundle proves its content matches what the platform produced at generation
  time, not that the underlying execution history itself was ever complete or
  correct (the card already documents its own degradation via `card.degraded`
  when a source was unavailable — the bundle inherits that honestly, it does
  not paper over it). Sharing the signing secret with a verifying third party
  is an out-of-band operational step this ADR does not prescribe — same as
  `AUDIT_ANCHOR_SECRET` distribution today.
- HMAC signing means only holders of the shared secret can verify (or forge)
  a bundle — acceptable for this feature's actual use case (an operator
  handing a specific bundle to a specific auditor/customer who is given the
  secret out of band), but not a substitute for a public-key scheme if a
  future requirement needs verification by an arbitrary, un-provisioned third
  party.

## Implementation

- `src/observability/evidence-bundle.ts` — `EvidenceBundle`/
  `SignedEvidenceBundle` types, `buildEvidenceBundle`, `signEvidenceBundle`,
  `verifyEvidenceBundle`, `canonicalizeForBundleHash`,
  `renderEvidenceBundleMarkdown`.
- `src/routes/explain.ts` — `GET /monitoring/explain/:executionId/bundle`
  (`monitoring:read`), `ExplainRouterDeps.auditAnchor` /
  `.evidenceBundleSecret`.
- `src/config/schema.ts`, `src/config/load.ts` — `EVIDENCE_BUNDLE_SECRET`
  (`z.string().min(16).optional()`).
- `src/index.ts` — wires `evidenceBundleSecret = config.evidenceBundleSecret
  ?? config.auditAnchorSecret` and the `AuditAnchorService` instance into the
  explain router.
- `scripts/cli.ts` — `verify-bundle <bundle.json> --secret <secret>`, fully
  offline.
- `apps/control/src/components/ExplainCard.tsx` — "Download Evidence Bundle"
  button.
- `src/observability/__tests__/evidence-bundle.test.ts`,
  `src/routes/__tests__/explain.test.ts`,
  `apps/control/src/__tests__/ExplainCard.test.tsx`.
