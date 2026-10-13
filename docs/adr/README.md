<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Architecture Decision Records (ADR) — Index

This directory records the architecture decisions of the ATF platform
(see [ADR 0001](0001-record-architecture-decisions.md) for the process).
New ADRs get the next free number; never reuse a number. Status values:
`Proposed`, `Accepted`, `Deprecated`, `Superseded by NNNN`.

| #    | Title                                                                                                     | Status    |
| ---- | --------------------------------------------------------------------------------------------------------- | --------- |
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md)                                    | Accepted  |
| 0002 | [Optional dependencies with graceful degradation](0002-optional-dependencies-graceful-degradation.md)     | Accepted  |
| 0003 | [Safe condition evaluator instead of eval / new Function](0003-safe-condition-evaluator.md)               | Accepted  |
| 0004 | [Keep the graph engine lean by extracting cohesive helpers](0004-modular-graph-engine.md)                 | Accepted  |
| 0005 | [Tenant data isolation model](0005-tenant-data-isolation.md)                                              | Accepted — application scoping is implemented; database-enforced RLS is an explicit deployment option, not enabled by default |
| 0006 | [Plugin trust boundary and isolation strategy](0006-plugin-trust-boundary-and-isolation.md)               | Accepted  |
| 0007 | [Reversible PII tokenization vault as a GraphEngineService decorator](0007-reversible-pii-vault-decorator.md) | Accepted |
| 0008 | [Autopilot governance: human-approval gate and drift-guard circuit breaker](0008-autopilot-governance-human-approval-and-drift-guard.md) | Accepted |
| 0009 | [Declarative compliance policy engine and a separate auto-generated evidentiary dossier](0009-compliance-policy-as-code-and-evidentiary-dossier.md) | Accepted |
| 0010 | [Continuous automated red-teaming as a scheduled security-posture engine](0010-continuous-automated-red-teaming.md) | Accepted |
| 0011 | [Declarative, hot-reloadable tool-authorization policy](0011-declarative-tool-authorization-policy.md)    | Accepted  |
| 0012 | [Self-optimizing flow loop with canary-gated, guarded auto-promotion](0012-self-optimizing-flow-loop-canary-gated-promotion.md) | Accepted |
| 0013 | [Backend-driven (BFF) OIDC session authentication for the operator plane](0013-oidc-backend-driven-session-authentication.md) | Accepted |
| 0014 | [Split `index.ts`'s wiring into focused `src/bootstrap/*.ts` builders](0014-bootstrap-composition-root-decomposition.md) | Accepted |
| 0015 | [Extensible PII Detector Pipeline](0015-extensible-pii-detector-pipeline.md)                              | Accepted  |
| 0016 | [Multimodal (image/file) PII handling in the reversible vault](0016-multimodal-pii-vault.md)              | Accepted  |
| 0017 | [Decision-Provenance Explainability Card](0017-decision-provenance-explainability-card.md)                | Accepted  |
| 0018 | [FinOps budget forecasting + CO2/ESG accounting](0018-finops-forecasting-and-co2-accounting.md)           | Accepted  |
| 0019 | [Agent Identity Broker and cross-scope Revocation Console](0019-agent-identity-broker-and-revocation-console.md) | Accepted |
| 0020 | [Verifiable Evidence Bundle](0020-verifiable-evidence-bundle.md)                                          | Accepted  |
| 0021 | [Objective-Driven Routing / Solver-Loop](0021-objective-driven-routing-solver-loop.md)                    | Accepted  |
| 0022 | [Org Skill Registry](0022-org-skill-registry.md)                                                          | Accepted  |
| 0023 | [Durable Agent Runtime](0023-durable-agent-runtime.md)                                                    | Accepted  |
| 0024 | [Shared security primitives in @atf/security-kit](0024-shared-security-kit.md)                            | Accepted  |
| 0025 | [Cross-service erasure orchestrated by the Runtime](0025-cross-service-erasure.md)                        | Accepted  |
| 0026 | [Audit integrity: hash chain plus signed external anchors](0026-audit-hash-chain-and-signed-anchors.md)  | Accepted  |
| 0027 | [Per-request CSP nonces for the operator plane](0027-csp-nonce-operator-plane.md)                         | Accepted  |
| 0028 | [Converter isolation behind a Unix-socket sidecar](0028-converter-isolation-sidecar.md)                   | Accepted  |
| 0029 | [Verifiable execution receipts (COSE_Sign1 + Merkle log)](0029-verifiable-execution-receipts.md)         | Accepted  |

## Conventions

- Language: English (matches the existing corpus).
- Structure: `# N. Title`, `Date:`, `## Status`, `## Context`, `## Decision`,
  `## Consequences` (see [ADR 0007](0007-reversible-pii-vault-decorator.md)
  as the reference shape).
- An ADR is written when a decision is hard to reverse, surprising without
  context, and the result of a real trade-off. Implementation details that
  any competent contributor would choose do not need an ADR.
