# Development

## Toolchain

- Bun 1.4.0 — the only package manager and task runner
- Node.js 26 — the supported compatibility baseline and the runtime for Node-backed artifacts
- TypeScript 7.0.2 — pinned as a workspace dependency
- Docker with Compose v2 — for the local multi-service stack

Versions are declared in `package.json`, `.nvmrc`, and `.node-version`. Do not use npm, pnpm, or
yarn; the workspace resolves exclusively from `bun.lock`.

```bash
bun install --frozen-lockfile
```

## The gates

These are what CI runs. Run them before opening a pull request:

```bash
bun run verify:public           # no secrets or forbidden paths in the tree
bun run verify:spdx             # tracked TypeScript source carries the project SPDX header
bun run supply-chain:check      # notices, SBOM, and license policy are current
bun run config-reference:check  # docs/CONFIGURATION.md matches the sources
bun run lint:baseline           # Biome findings have not grown past the baseline
bun run typecheck
bun run test
bun run test:contracts
bun run build
```

CI also validates the example flows and boots the quickstart Compose stack against the
documented health endpoints. Two gates behave differently from how they read:

- `lint:baseline` is a regression gate. `.biome-baseline.json` records the pre-existing findings
  and the gate fails only when they grow, so `bunx biome ci .` will report findings that CI
  tolerates. Use `bun run lint` to see them all, and `bun run lint:baseline -- --update` to
  tighten the baseline after reducing them.
- `verify:public` runs without the confidential redaction rule set in ordinary CI, so it applies
  only its structural rules there. The tag-release workflow requires the repository Actions
  secret `ATF_REDACTION_RULES_JSON` and runs the release guard against the exact tag commit; a
  missing, malformed, or matching rule set blocks publication.

Regenerate after the relevant change, and commit the result:

```bash
bun run spdx              # after adding source files
bun run supply-chain      # Linux x64 only: refresh the committed workspace reference
bun run config-reference  # after adding or changing a configuration variable
```

The root notices and SBOM are the committed Linux x64 workspace reference; do not regenerate
them on macOS with a Linux platform label. `--platform` records the target and
`--assert-host-platform` makes native CI fail if the runner is not that platform. CI separately
generates commit-specific `linux-x64` and `darwin-arm64` workspace artifacts and inventories
the four final Quickstart image targets from inside each image. For an intentional local
platform artifact, use an isolated output directory, for example:

```bash
bun run supply-chain --inventory-root "$PWD" --output-dir artifacts/local-darwin-arm64 \
  --platform darwin-arm64 --assert-host-platform --artifact-kind workspace \
  --artifact-name local-darwin-arm64 --git-sha "$(git rev-parse HEAD)"
```

A dependency is not accepted unless every component has a complete text. Resolution uses the
package first, then reviewed package-embedded sections, exact-repository/exact-license installed
monorepo text, explicit supplemental rules, and only the exact-version declared-license
fallbacks documented in `licenses/README.md`.

`verify:public` warns and passes when the confidential redaction rule set is absent, which is
the normal case for contributors and ordinary CI. Before enabling tag publication, configure
the repository Actions secret `ATF_REDACTION_RULES_JSON` with the JSON rule document described
by `scripts/redaction-rules.example.json`. The tag workflow writes it to a mode-restricted runner
temporary file and invokes `verify-public-tree.ts --require-rules`; it never publishes when the
secret is absent or invalid.

## Working in one workspace

```bash
bun run --filter @atf/runtime dev
bun run --filter @atf/runtime test
bun run --filter @atf/search typecheck
bun run --filter @atf/control build
```

Run a single test file or filter by name:

```bash
bun test apps/runtime/src/graph/__tests__/groundedness.test.ts
bun test -t "approval"                                         # by test name
bun run --filter @atf/control test -- ApprovalsPanel           # Vitest
```

`bun test` filters by test name with `-t`, not `--filter`. `--filter` selects a
*workspace* and belongs to `bun run`, as in `bun run --filter @atf/runtime test`.

Search and Control use Vitest; Runtime, Gate, and the contract packages use `bun test`.

`bun run --filter @atf/search build:node` produces the optional Search Node.js 26 artifact. It is
only needed when a deployment requires a Node runtime for Search.

## Tests that need infrastructure

Most tests run with no external services. These do not, and are gated behind environment
variables so a plain `bun run test` stays green without them:

| Variable | Enables |
| --- | --- |
| `TEST_POSTGRES_URL` | Runtime database, migration, and row-level-security tests |
| `POSTGRES_URL` | Search integration tests |
| `RUN_MODEL_INTEGRATION` | Runtime tests against a real model provider |
| `MCPGATE_LLM_E2E`, `LLM_BASE_URL` | Gate end-to-end tests against a local model server |

A PostgreSQL with pgvector for local runs:

```bash
docker run --rm -d --name atf-test-pg -p 5432:5432 \
  -e POSTGRES_DB=atf_test -e POSTGRES_USER=atf -e POSTGRES_PASSWORD=atf-local-only \
  pgvector/pgvector:0.8.1-pg18
export TEST_POSTGRES_URL=postgres://atf:atf-local-only@127.0.0.1:5432/atf_test
```

Control's Playwright suites need a running stack:

```bash
bun run --filter @atf/control test:e2e
bun run --filter @atf/control test:e2e:report
```

Visual snapshots are committed per platform. Regenerate with `--update-snapshots` and review the
image diff before committing; an unexplained snapshot change is a review blocker.

## Local stack

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml up --build -d
```

Brings up all five applications, PostgreSQL/pgvector, and a deterministic mock model, so no API
key is needed. Details, ports, and the security boundary: `deploy/examples/README.md`. It is
explicitly unauthenticated and is never a production baseline.

## Flows

Validate offline before deploying:

```bash
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/examples/flows/
bun run scripts/cli.ts diff flows/v1.yaml flows/v2.yaml
bun run scripts/cli.ts deploy flows/my-flow.yaml --server http://127.0.0.1:3000
```

The validator checks more than the JSON schema does: edge reference integrity, node type and
config compatibility, and provider references against the registry. Examples and the flow
authoring reference: `deploy/examples/flows/README.md`.

## Configuration

Runtime parses the environment declared in its Zod `EnvSchema` at startup and exits with the
full list of problems rather than failing at first use. When you add a variable:

1. add it to the schema (`apps/runtime/src/config/schema.ts`) with a default or an explicit
   `.optional()`, and a JSDoc comment — the comment becomes the documentation;
2. run `bun run config-reference` and commit `docs/CONFIGURATION.md`;
3. add it to the relevant `.env.example` if an operator would plausibly need to set it.

Put it in the schema, not in a direct `process.env` read. `bun run config-reference` scans for
raw reads as a second pass and will still document what it finds, but it marks the variable
**read directly — not validated at startup**, which is a defect to avoid rather than a pattern
to copy. A handful of existing variables carry that marker; they predate the rule and are
tracked for migration into the schema.

## Contracts and fixtures

A message that crosses a service boundary belongs in a versioned package under `packages/`, with
Zod validation, exports, tests, and a compatibility test. A service-local wire envelope is
acceptable only when the protocol genuinely differs — document that distinction, because
mistaking a local envelope for a shared record is the failure mode `integration/system` exists to
catch.

Tests, docs, prompts, screenshots, and examples use synthetic names, reserved example domains
(`example.com`, `example.test`, `example.invalid`), and RFC 5737 documentation IP ranges. Never
copy customer documents, names, identifiers, endpoints, or production traces into this
repository.

## Adding a dependency

```bash
bun add --filter @atf/runtime some-package
bun run supply-chain          # regenerate notices and SBOM
```

Commit `bun.lock`, `THIRD_PARTY_NOTICES.md`, and `sbom.cdx.json` together. The license policy in
`scripts/generate-supply-chain.ts` fails the run on strong-copyleft and
source-available-competitor licenses, and on a weak-copyleft dependency that ships no license
text. If a dependency you need trips it, raise it in the issue rather than adding an exception
yourself.
