# ATF repository instructions

These instructions apply to every task in this repository. The release section is
binding: it consolidates the repository's release hook (`.kiro/hooks/atf-github-release.json`,
which is gitignored) so the workflow survives tooling changes. If this file and a
repository workflow disagree, the workflow in `.github/workflows/` wins — stop and say so.

## Ground rules

- Work only in `Abillify/atf`. Never run release commands from a clone of another repository.
- Push only to the remote `origin`. Never push to `gitlab` or any other remote.
- Never discard, reset, clean or stash work you did not create. If the tree is dirty in a way
  that blocks the task, report it and stop.
- Untracked files that are not part of the task stay untouched and unstaged.
- External or irreversible actions (push, tag, release, merging a PR) require explicit user
  approval in the current conversation. Preparing, verifying and proposing them does not.

## Release workflow (`atf-github-release`)

### 1. Establish the base

```bash
gh auth status
gh repo view --json nameWithOwner          # must be exactly Abillify/atf
git fetch origin main --tags
gh api repos/Abillify/atf/releases/latest --jq .tagName   # base tag, no guessing
```

- The base tag must match `vMAJOR.MINOR.PATCH` exactly. No prerelease suffix, no fallback to
  an assumed version. If it does not match, stop.
- `HEAD` must equal `origin/main`. If local commits are not on `origin/main`, resolve that
  first (push or the pull-request flow) before building a release commit — a release commit
  must never carry unreleased feature work with it.
- Decide the bump from the changes since the base tag. Ask the user when the choice is not
  obvious from the diff. Verify the target tag and release do not already exist:
  `git rev-parse -q --verify "refs/tags/vX.Y.Z"` and
  `gh release view vX.Y.Z --repo Abillify/atf`.

### 2. Confidentiality scan (fail closed, three passes)

The scan uses the gitignored rule set `internal/redaction-rules.json` (or the file pointed to
by `ATF_REDACTION_RULES`) and must run:

1. before any version or metadata change,
2. after all changes, immediately before the first `git add`,
3. again on the clean release commit, immediately before pushing.

```bash
rules="internal/redaction-rules.json"
test -s "$rules"
export ATF_REDACTION_RULES="$rules"
bun run scripts/verify-public-tree.ts --require-rules --rules "$ATF_REDACTION_RULES"
```

- Never print, quote, or commit the rule file or its patterns; report only pass/fail and counts.
- Never add `internal/` (or any rule file) to a commit, and never weaken the script to make it pass.
- In CI and in the release workflow the same rules come from the `ATF_REDACTION_RULES_JSON`
  secret, so a local pass is a precondition, not a substitute.
- In addition to the automated scan, read the whole diff since the base tag and check it
  semantically for customer names, internal hostnames, endpoints, credentials and pricing.

### 3. Content rules

- `CHANGELOG.md`: add a dated `## [X.Y.Z]` section under Keep a Changelog headings, and update
  the compare links at the bottom (`[X.Y.Z]: .../compare/<base>...vX.Y.Z`, `[Unreleased]: .../compare/vX.Y.Z...HEAD`).
- Bump the version in the root `package.json`, run `bun run version:sync`, refresh the lockfile
  entry, then `bun run verify:version`.
- `docs/FLOWS.md` and `apps/runtime/schemas/flow.schema.json` are generated from
  `apps/runtime/src/graph/node-type-catalog.ts`. Never hand-edit them — change the catalog and
  run `bun run flow-reference`. The same applies to the generated route table (`route-reference`).
- Flow YAML changes require a flow `metadata.version` bump (`bun run check:flow-versions`).

### 4. Gates

Run from the repository root unless noted. All must pass on the exact release commit.

```bash
bun install --frozen-lockfile
bun run verify:public:release
bun run verify:spdx
bun run verify:version
bun run supply-chain:check
bun run config-reference:check
bun run lint:baseline
bun run typecheck
bun run test
bun run test:contracts
bun run build
bun run check:budgets:ci
bun run flow-reference:check
bun run route-reference:check
bun run openapi:check
bun run check:links
```

and in `apps/runtime`:

```bash
bun run scripts/cli.ts validate ../../deploy/examples/flows/
```

- `supply-chain:check` regenerates `THIRD_PARTY_NOTICES.md` / `sbom.cdx.json` for the
  linux/amd64 artifact and needs a linux/amd64 container. If no container runtime is
  available locally, say so explicitly and rely on CI — do not commit host-platform output
  and do not skip the gate silently.
- Prefer the `packageManager`-pinned Bun version for the budget gate; note the local version
  when it differs.
- If a gate cannot run, state which one and why in the approval request. Never claim a gate
  passed that did not run.

### 5. Commits

- Split commits by concern; Conventional Commit messages. A commit is `chore(release): vX.Y.Z`
  only if it contains release metadata (version, lockfile, changelog) exclusively. Generated
  doc fixes and feature follow-ups are separate commits.
- Stage explicit paths (`git add -- <paths>`); never `git add .` or `-A`.
- Commits must use the work email without changing git config:
  `git -c user.email="a.krueger@abillify.me" commit -m "..."`, and keep the existing
  `user.name`.
- Preserve the contributor trailer used by the PR template:
  `ATF-Contributor-Assignment-Accepted: 1.0, Artur Krueger <a.krueger@abillify.me>`.
- Verify before pushing: `git log --format='%H %ae %ce %s' <base>..HEAD` — every author and
  committer email must be `a.krueger@abillify.me`, and the trailer must be present.

### 6. Push, tag, release

1. Ask for approval, show the file list, the diff summary, the target version and the ordered
   commit series.
2. After approval: confirm a clean tree, `git push origin main`, then wait for a successful
   `.github/workflows/ci.yml` run on the exact new SHA
   (`gh run list --workflow ci.yml --branch main`).
3. Tagging needs its own approval. Prefer a signed annotated tag
   (`git tag -s vX.Y.Z -m "vX.Y.Z"`). If signing is unavailable, stop and ask — never fall
   back to an unsigned tag silently. Push only that tag (`git push origin vX.Y.Z`).
4. Never run `gh release create` locally. `.github/workflows/release.yml` is triggered by the
   tag, re-verifies the exact SHA, `main` ancestry, package version, successful CI and the
   redaction scan, and produces the release plus its supply-chain bundle.
5. Verify with `gh release view vX.Y.Z --repo Abillify/atf` and report the release URL, the
   CI run and any gate that could not be executed locally.
