<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 28. Converter isolation behind a Unix-socket sidecar

Date: 2026-10-08

## Status

Accepted

## Context

Document conversion shells out to poppler (`pdftoppm`) and LibreOffice —
large C/C++ codebases with a steady stream of CVEs, parsing hostile files
from untrusted sources. Running them inside the Extract container means a
successful exploit gets the Extract process's whole environment: the
database URL, service credentials and the internal network.

## Decision

Extract supports two converter modes (`CONVERTER_MODE`,
`apps/extract/src/config.ts`):

- `local` (default): binaries run in-process-environment as before —
  convenient for development and single-container deployments.
- `isolated`: the binaries run in a dedicated `extract-converter` sidecar
  container with **no network, a read-only root filesystem and a seccomp
  profile**. Extract forwards every conversion over a Unix socket
  (`CONVERTER_SOCKET`); the scratch directory is mounted from one volume at
  the **same absolute path in both containers** because the RPC carries
  paths, not bytes.

Subprocess limits (memory, CPU seconds, wall-clock timeout) apply in both
modes (`configureSubprocessLimits`). In isolated mode a sidecar that is not
reachable surfaces as `CONVERTER_UNAVAILABLE` on the first conversion —
fail-visible, not a boot-time crash and not a silent fallback to `local`.

## Consequences

- A converter exploit lands in a container with no network egress, no
  writable root and no service secrets — the blast radius is one file in a
  shared scratch volume.
- The path-sharing contract is a deployment invariant: both containers must
  mount the scratch volume at the identical path (the compose contract in
  the deployment repositories encodes this).
- Isolation costs one container and a local RPC hop per conversion; CPU
  headroom for the sidecar must be sized separately (see the scaling
  runbook).
