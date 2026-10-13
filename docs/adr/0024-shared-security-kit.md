<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 24. Shared security primitives in @atf/security-kit

Date: 2026-10-08

## Status

Accepted

## Context

Before the platform-hardening work, each service grew its own copies of
security-critical primitives: base64url helpers, constant-time comparison,
JWT verification, SSRF-safe fetch wrappers and rate limiters existed two to
four times across Runtime, Gate, Search, Extract and Control. Copies drift:
one service forgot `timingSafeEqual`, another accepted `alg: none` on a
code path, and a "secure by default" fix in one service silently did not
reach the others. Security fixes had to be applied N times and audited N
times.

## Decision

All reusable security primitives live in the workspace package
`@atf/security-kit` (`packages/security-kit`):

- constant-time comparison (`compare.ts`) and base64url (`base64url.ts`);
- the Egress Guard (`egress/`) — an SSRF-safe fetch wrapper that resolves
  and rejects link-local, loopback and private ranges per request, with an
  explicit allow-list;
- JWT/OIDC verification (`jwt/`) — multi-issuer routing, JWKS caching and
  discovery caching, strict algorithm pinning;
- a GCRA rate limiter (`rate-limit/`) with memory and Redis backends;
- HTTP security-header defaults (`headers.ts`) and Prod_Gate rule building
  blocks (`prod-gate/`).

Services must not re-implement these primitives; new security code goes
into the kit and is consumed from there. The package is Node-only; browser
code may only import `@atf/security-kit/browser`, which exposes the
base64url helpers and nothing else — this keeps Node crypto out of client
bundles and shrinks the browser attack surface to a deliberate, audited
subset.

## Consequences

- One audit surface for the primitives; a fix lands once and reaches every
  service on the next build.
- The kit becomes a dependency of every service, so its public API is held
  deliberately small and its own test coverage is part of the security
  coverage gate (`bun run coverage:security`).
- The browser/Node split must be respected at import time; importing the
  root entry from client code is a build error by construction (Node-only
  APIs), which is the intended failure mode.
