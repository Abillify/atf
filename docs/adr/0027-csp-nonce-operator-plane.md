<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 27. Per-request CSP nonces for the operator plane

Date: 2026-10-08

## Status

Accepted

## Context

Control (the Next.js operator plane) needs a strict Content-Security-Policy
(Req. 8). A policy without `unsafe-inline` breaks any inline `<script>` or
`<style>` — but the theme/density bootstrap and the BFF session publication
must run before hydration, i.e. inline in the document. The usual shortcuts
(`unsafe-inline`, hashing static content) either weaken the policy for every
request or fail on dynamic content.

## Decision

Control emits a **fresh cryptographic nonce per request**
(`apps/control/src/proxy.ts`, Next 16 middleware; policy in
`src/lib/csp-policy.ts`):

- the middleware generates a nonce and writes it into the response's CSP
  header (`script-src 'nonce-…'`) and into a request header
  (`CSP_NONCE_REQUEST_HEADER`) that server components read;
- `app/layout.tsx` attaches that nonce to the theme bootstrap script and,
  in BFF mode, to the session-publication script — the only inline scripts
  allowed, both fixed server-provided literals;
- `next.config.ts` deliberately declares **no** CSP: static config cannot
  carry a per-request nonce, so header emission moved entirely to the
  middleware.

## Consequences

- `unsafe-inline` is not needed anywhere; an injected inline script without
  the current request's nonce is blocked by the browser.
- HTML responses that contain a nonce must not be cached by shared caches;
  the middleware's cache headers account for this.
- Any future inline script in Control must go through the nonce plumbing —
  a deliberate speed bump that keeps the inline-script surface small and
  auditable.
