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
