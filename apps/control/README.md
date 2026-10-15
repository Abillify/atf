# @atf/control

The operator and governance interface. Next.js 16, React 19, Tailwind 4.

Control uses [`@atf/runtime`](../runtime)'s HTTP API and SSE monitoring stream. Its Next.js
server supplies the web application and optional response headers, but it holds no provider or
database credentials, talks to no database, and reaches no model provider. That boundary is
deliberate: Control can be deployed behind a different ingress, restricted to an internal
network, or omitted entirely without affecting Runtime.

## Run it

From the repository root:

```bash
cp apps/control/.env.example apps/control/.env
PORT=3001 bun run --filter @atf/control dev
```

Control is then available at <http://127.0.0.1:3001>. The example environment sets
`NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3000` for development without a proxy. The simplest way
to run the services together is [`deploy/examples/`](../../deploy/examples/).

```bash
bun run --filter @atf/control test        # Vitest unit and component tests
bun run --filter @atf/control test:e2e    # Playwright, needs a running stack
bun run --filter @atf/control typecheck
bun run --filter @atf/control build
```

## What it covers

| Area | Function |
| --- | --- |
| Flows | Registry; Studio for editing (canvas, per-type settings forms with node docs, variables table, ƒx expression builder, Copilot, drafts/publish/diff, test runs); graph visualization with live execution overlay |
| Providers | Provider and pool health, provider testing bench |
| Traces | Execution history, debug trace viewer, decision provenance |
| Approvals | Reviewer inbox with pending count, role-gated approve and reject |
| Cost | Spend per tenant, day, and model; budgets; anomalies; FinOps forecast |
| Quality | Evaluation runs and cases, canary status, shadow comparisons, autopilot state |
| Compliance | Policy view, generated dossier, DSAR and erasure handling |
| Tenants | Tenants, provider keys, budgets, limits |
| Assistants | Assistant and skill registry administration |
| Monitoring | Live execution events, SLO panels |
| Language | German and English UI (cookie `NEXT_LOCALE`, switch in the header) |

## Configuration

Four optional variables are documented in [`.env.example`](.env.example):

- `NEXT_PUBLIC_BACKEND_URL` — explicit development or cross-origin Runtime base URL as reached
  from the browser. Next.js freezes `NEXT_PUBLIC_*` into the browser bundle at build time. Omit
  it in production to use relative same-origin URLs; the deployment's reverse proxy must then
  route Runtime paths because Control has no built-in API rewrite.
- `NEXT_PUBLIC_CURRENCY` — currency label (`EUR` (default), `USD`, `CHF`, `GBP`) shown in front of
  every cost figure. Purely a label: values are never converted. Must match the Runtime's
  `CURRENCY`. Frozen into the browser bundle at build time, so change it via the build argument
  or `.env` before `next build`, not at container runtime.
- `CONTROL_CSP_MODE` — `enforce` (default since 0.15) emits an enforcing `Content-Security-Policy`
  with a per-request script nonce (generated in `src/proxy.ts`, applied to Next's own scripts and
  the theme-init script). `report-only` emits `Content-Security-Policy-Report-Only` for rollout
  observation; `legacy` emits no CSP header (pre-0.15 behaviour — set it explicitly to restore).
  Baseline security headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `X-Frame-Options`, and `Strict-Transport-Security` over HTTPS) are emitted in every mode.

- `CONTROL_PUBLIC_ORIGIN` — the public origin of Control (for example `https://control.example.com`),
  used by the same-origin guard of the BFF routes (`/api/session`, `/api/backend`, `/api/telemetry`).
  When set, only that origin's host is accepted for the `Origin` header and `X-Forwarded-Host` is
  ignored; an invalid value rejects every request that carries an `Origin`. When unset, the guard
  also trusts `X-Forwarded-Host` and `Host`, so the reverse proxy MUST overwrite `X-Forwarded-Host`
  (never pass a client-supplied value through). Set it in every BFF deployment behind a proxy.
- **BFF mode and session renewal** (`CONTROL_SESSION_MODE=bff`): there is no silent token renewal,
  because the Runtime refresh session is a cookie on the Runtime origin that Control cannot reach
  and the access token stays server-side. When the sealed session expires, the user signs in again
  through interactive SSO.
## Testing

- **Unit and component**: Vitest with Testing Library, in `src/__tests__/`.
- **End-to-end**: Playwright in `e2e/`, covering dashboard navigation, the SSE monitoring
  stream, the trace viewer, and DSAR compliance flows.
- **BFF origin**: `e2e/bff-origin.spec.ts` runs only with `E2E_BFF=1` against a BFF-mode server with
  `CONTROL_PUBLIC_ORIGIN` set; the route tests in `src/app/api/` cover the same cases offline.
- **Accessibility**: `e2e/a11y-sweep.spec.ts` and `e2e/a11y-responsive.spec.ts` run axe-core
  across the dashboard at several viewports. Automated checks catch a subset of issues; they do
  not substitute for testing with assistive technology.
- **Visual regression**: `e2e/visual.spec.ts` with committed snapshots per platform. Regenerate
  with `--update-snapshots` and review the diff before committing.
- **Performance budgets**: `playwright.performance.config.ts` with budgets in
  [`budgets/default.json`](../../budgets/default.json), reported by
  `bun run check:budgets` and enforced by `bun run check:budgets:ci`.

## Conventions

All user-visible text goes through the i18n catalogs in `src/lib/i18n/catalogs/` (`ui.en.ts`,
`ui.de.ts`; the German catalog must translate every key and keep every `{placeholder}`). Use
`translate("area.key", { name })` or `useI18n().t`. `src/__tests__/i18n-coverage.test.ts` fails on
hard-coded JSX text, descriptive attributes, and strings passed to `new Error(...)`, `setError(...)`
and toasts. `e2e/i18n-de.spec.ts` renders every dashboard route in German.


Component and styling conventions are in
[`docs/UI-STYLE-GUIDE.md`](../../docs/UI-STYLE-GUIDE.md). New interactive elements need keyboard
operation, a visible focus state, and an accessible name; the a11y sweep will fail otherwise.
