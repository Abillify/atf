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

## Configuration

Two optional variables are documented in [`.env.example`](.env.example):

- `NEXT_PUBLIC_BACKEND_URL` — explicit development or cross-origin Runtime base URL as reached
  from the browser. Next.js freezes `NEXT_PUBLIC_*` into the browser bundle at build time. Omit
  it in production to use relative same-origin URLs; the deployment's reverse proxy must then
  route Runtime paths because Control has no built-in API rewrite.
- `CONTROL_CSP_MODE` — `legacy` (default) emits no CSP header. `report-only` emits
  `Content-Security-Policy-Report-Only` so operators can observe violations before deciding on
  an enforcement policy at their ingress. Control currently never emits an enforcement
  `Content-Security-Policy` header.

## Testing

- **Unit and component**: Vitest with Testing Library, in `src/__tests__/`.
- **End-to-end**: Playwright in `e2e/`, covering dashboard navigation, the SSE monitoring
  stream, the trace viewer, and DSAR compliance flows.
- **Accessibility**: `e2e/a11y-sweep.spec.ts` and `e2e/a11y-responsive.spec.ts` run axe-core
  across the dashboard at several viewports. Automated checks catch a subset of issues; they do
  not substitute for testing with assistive technology.
- **Visual regression**: `e2e/visual.spec.ts` with committed snapshots per platform. Regenerate
  with `--update-snapshots` and review the diff before committing.
- **Performance budgets**: `playwright.performance.config.ts` with budgets in
  [`budgets/default.json`](../../budgets/default.json), reported by
  `bun run check:budgets` and enforced by `bun run check:budgets:ci`.

## Conventions

Component and styling conventions are in
[`docs/UI-STYLE-GUIDE.md`](../../docs/UI-STYLE-GUIDE.md). New interactive elements need keyboard
operation, a visible focus state, and an accessible name; the a11y sweep will fail otherwise.
