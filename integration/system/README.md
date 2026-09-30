# System contract integration

This workspace verifies that ATF's independently versioned contracts still fit the real
applications that produce and consume them. It imports production code across workspace
boundaries deliberately: a contract package can be internally valid while Runtime, Gate, or
Control has drifted away from it.

The current lifecycle checks cover:

- a transaction JWT issued and validated by Runtime, then parsed under the strict producer and
  tolerant Gate consumer contracts;
- evidence metadata produced by Runtime and accepted with the same hash by Gate;
- an actual Runtime jobs HTTP response consumed by Control's contract parser.

Run the workspace directly:

```bash
bun run --filter @atf/system-integration typecheck
bun run --filter @atf/system-integration test
```

Or run the repository-level contract gate:

```bash
bun run test:contracts
```

These tests are boundary checks, not end-to-end deployment tests. They use in-memory stores and
synthetic values, require no credentials or external services, and run in CI.

## Outpost integration (`outpost.test.ts`)

`outpost.test.ts` is the exception: it exercises the real Outpost → Extract → Search chain
(new/version/delete cases, Keycloak audience, container SIGTERM, image non-root/size, the
`source-login` TTY path per task 20.13). It skips with a clear message unless the environment
provides live services:

| Variable | Purpose |
| --- | --- |
| `OUTPOST_IT_EXTRACT_URL` | Extract base URL (token needs `extract.ingest` and `extract.delete`) |
| `OUTPOST_IT_EXTRACT_TOKEN` | Bearer token for Extract |
| `OUTPOST_IT_SEARCH_URL` | optional Search URL for the retrieval check |
| `OUTPOST_IT_IMAGE` | optional image (default `ghcr.io/abillify/atf-outpost:latest`) |

Run it against a local Extract/Search stack:

```bash
OUTPOST_IT_EXTRACT_URL=... OUTPOST_IT_EXTRACT_TOKEN=... bun test ./outpost.test.ts
```

Notes for a full local run:

- The Search service must run with `BATCH_WORKER=true`; otherwise staged batches are never
  processed and the retrieval check finds no hits.
- The S3 case starts a throwaway MinIO container on `127.0.0.1:19000` and seeds the bucket
  with the `aws` CLI; it skips when either `docker` or `aws` is unavailable.
- With `AUTHN_MODE=disabled` on Extract, the Keycloak-audience case skips by design.
- The interactive `source-login` flow against a fake provider is covered by the unit test
  `stores the refresh token after a successful code exchange` in `apps/outpost/src/`
  (live fake providers would need port 443 and fixed OAuth endpoints per requirement 15.1).
