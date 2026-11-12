<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Flow cookbook

Twelve small flows, one pattern each, every one of them passing the flow validator. The
narrative is [docs/FLOW-COOKBOOK.md](../../../../docs/FLOW-COOKBOOK.md); this directory holds
the files behind its excerpts, so a snippet in the docs is always a complete, validatable flow
rather than a fragment that only looks plausible.

```bash
cd apps/runtime
bun run scripts/cli.ts validate ../../deploy/examples/flows/cookbook/ --require-version
```

## These flows are not loaded by the quickstart stack

Deliberately. The Runtime scans `FLOWS_DIR` one level deep and does not recurse, so a
subdirectory of the flows directory is invisible to it — the cookbook can be validated in CI
without ever becoming part of a running deployment, where twelve extra flows in `GET /v1/models`
would be noise. The same trick keeps `bench/` and `prompts/` out of the flow list.

Copying a recipe into production means copying the file up one level (or into your own flows
directory) and giving it an `id` that does not collide: the ids here are prefixed `cb-` for
exactly that reason, and every name is also free in the parent directory.

## Why there is a `model-shortcuts.yaml` here

A flow directory needs a shortcuts file to be a flow root, and the validator resolves
`llm.shortcut` against it. The CLI locates the root by walking up from the scanned directory to
the nearest `model-shortcuts.{yaml,yml,json}`, so without this file the recipes would resolve
against the parent directory's — and a cookbook that documented a shortcut the parent happens to
define would break the next time that file changed. This file defines its own `chat`,
`structured` and `balanced` shortcuts over the `local` and `hosted` engines, which is also why
none of the recipes needs a `PROVIDERS` entry to validate: engine names are resolved at
execution time, not at load time.

Recipes that need a model beyond those three (a vision model, a specific small local model)
declare it inline with `llm.provider` and `llm.model` and say so in a comment.

## Why nothing here uses `{{const.*}}`

`constants.yaml` is deployment-wide and read by the Runtime's flow loader. The CLI validator
does not read it, so `{{const.answer_max_tokens}}` fails offline while working in production —
which is the worst possible property for an example. Recipe 07 explains variables, calculations
and where a constant would go, and [`constants.example.yaml`](constants.example.yaml) shows the
file's shape without any flow depending on it. Both are named `.example` because the CLI skips
`*.example.*` when collecting flows.

## Reading order

| File | Pattern |
| --- | --- |
| [`01-classifier-routing.yaml`](01-classifier-routing.yaml) | Route on a validated field; the catch-all edge and why there is no `else` |
| [`02-model-pool-sticky.yaml`](02-model-pool-sticky.yaml) | Fail-over chain, sticky pool, per-request cost/quality routing |
| [`03-cascade-cheap-to-strong.yaml`](03-cascade-cheap-to-strong.yaml) | Regenerate on a measurable quality signal, not on a schedule |
| [`04-rag-citations.yaml`](04-rag-citations.yaml) | Retrieval profiles, inline citations, runtime source check |
| [`05-tool-loop-budget.yaml`](05-tool-loop-budget.yaml) | Every ceiling that keeps an agent loop bounded |
| [`06-subflows-prompt-files.yaml`](06-subflows-prompt-files.yaml) | Split across files with `$include` and `#[[file:…]]` |
| [`07-variables-calculations.yaml`](07-variables-calculations.yaml) | Variables, load-time calculations, request overrides |
| [`08-parallel-fanout.yaml`](08-parallel-fanout.yaml) | Fan out, fuse, conditional child, downweight what came before |
| [`09-approval-write-tool.yaml`](09-approval-write-tool.yaml) | A write tool a person approves, and the forced tool sequence |
| [`10-image-inspection.yaml`](10-image-inspection.yaml) | Read an attachment with a vision model, embed the figure |
| [`11-small-local-model.yaml`](11-small-local-model.yaml) | The settings a small local model actually needs |
| [`12-error-fallback.yaml`](12-error-fallback.yaml) | Keep a run alive on a degraded answer |

Supporting files: [`model-shortcuts.yaml`](model-shortcuts.yaml) (see above),
[`constants.example.yaml`](constants.example.yaml), [`subflows/`](subflows/) (the fragment
recipe 06 includes), [`prompts/`](prompts/) (prompt files for 04 and 06).

## Conventions

- Each file is one pattern. When a recipe looks like two patterns glued together, the second one
  is there because the first does not work without it — the comment says which.
- Comments explain the *why* and the failure mode, not the syntax; the field reference is
  [docs/FLOWS.md](../../../../docs/FLOWS.md).
- A recipe states what it needs beyond the quickstart, and what silently does nothing when that
  is missing. That is the point of the last comment block in each file.
- `metadata.version` is bumped on every substantive change
  (`bun run check:flow-versions` enforces it for tracked flows).
