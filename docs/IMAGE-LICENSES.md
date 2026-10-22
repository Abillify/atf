# Image Licenses

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the generated SBOMs
cover the JavaScript (and Rust) dependency tree. They deliberately make **no
claim about the OS packages inside a container image** — an image is more than
its `node_modules`. This document closes that gap: which base images ATF
ships, which copyleft OS packages land in them, why that does not affect the
Elastic License 2.0 terms on ATF's own source, and where the machine-readable
per-image license inventory lives.

## Published images

Production images are built from `deploy/images/Dockerfile.<service>` by the
`Container images` job in `.github/workflows/release.yml` and published to
`ghcr.io/abillify/atf-<service>`. Quickstart images are built from
`deploy/examples/Dockerfile`.

| Image | Runtime base | Copyleft OS packages in the final image |
| --- | --- | --- |
| `atf-runtime` | `oven/bun:1.4.3-distroless` (Debian distroless) | none beyond the distroless base |
| `atf-search` | `oven/bun:1.4.3-distroless` | none beyond the distroless base |
| `atf-gate` | `oven/bun:1.4.3-distroless` | none beyond the distroless base |
| `atf-control` | `node:26-alpine` (Alpine) | none beyond the Alpine base |
| `atf-extract` | `debian:bookworm-slim` | poppler, LibreOffice, fonts (see below) |
| Quickstart (`runtime`, `control`, `search`, `gate`) | `oven/bun:1.4.3` (Debian) | none beyond the Debian base |
| Quickstart `extract` | `oven/bun:1.4.3` (Debian) | same package set as `atf-extract` |

All bases are pinned by immutable digest in the Dockerfiles.

## The extract image: poppler and LibreOffice

`deploy/images/Dockerfile.extract` installs, via
`apt-get install --no-install-recommends`:

| Debian package | Upstream license | Role in ATF |
| --- | --- | --- |
| `poppler-utils` | GPL-2.0-or-later **or** MPL-2.0 (dual) | `pdftotext` / `pdfinfo` — text and geometry extraction |
| `libreoffice-writer-nogui`, `-calc-nogui`, `-impress-nogui`, `-draw-nogui` | MPL-2.0 **or** LGPL-3.0-or-later (dual) | Office-format conversion (`soffice --convert-to`) |
| `fonts-liberation` | OFL-1.1 (with GPL-2.0 + font exception alternative) | metric-compatible fonts for faithful rendering |
| `fonts-dejavu-core` | Bitstream Vera / Arev (permissive) | fallback glyphs |
| `tini` | Apache-2.0 | PID 1 reaper for LibreOffice child processes |
| `ca-certificates` | MPL-2.0 | TLS trust store |

## Why this does not make ATF a derivative work

ATF invokes poppler and LibreOffice exclusively as **separate operating-system
processes** through `execFile` with an argument array
([`apps/extract/src/pipeline/exec.ts`](../apps/extract/src/pipeline/exec.ts)) —
never as linked libraries, never in-process, with no shared address space and
no static linking. The converters communicate over process boundaries
(argv/stdin/stdout/exit code) exactly as a shell pipeline would; the same
browsers, editors, and CI systems ship on every Linux distribution.

Under both the GPL and the LGPL, copyleft obligations attach to derivative
works of the licensed program, not to independent programs that exchange data
with it over an ordinary IPC boundary. ATF's code is the latter: it would
compile, link, and run unchanged against any poppler or LibreOffice build, and
neither converter includes or embeds ATF code. The process boundary therefore
keeps ATF's source under the Elastic License 2.0 unchanged.

What distribution of the **images** does trigger are the ordinary obligations
for the copyleft packages themselves — license texts and source availability —
which Debian satisfies out of the box:

- Every Debian binary package ships its license in
  `/usr/share/doc/<package>/copyright` inside the image, and the base images
  include `/usr/share/common-licenses` (GPL, LGPL, MPL, FSF texts).
- The exact source for every installed package version is available from the
  Debian archive for the pinned base digest, including
  [snapshot.debian.org](https://snapshot.debian.org/) for the historical
  versions the pinned digests refer to.
- The dual-licensed components (poppler, LibreOffice) additionally allow
  recipients to take the MPL file-level variant, whose source is the upstream
  git history.

## Machine-readable license inventory per image

The release workflow scans **every** published service image with
[Trivy](https://github.com/aquasecurity/trivy) (version-pinned and
checksum-verified, the same pin as the CI `image-scan` job):

```
trivy image --scanners license --format cyclonedx \
  --output atf-<service>-licenses.cdx.json <image>@<digest>
```

The resulting `atf-<service>-licenses.cdx.json` files — one per service,
containing the detected effective license of every OS package in the final
image — are added to the checksummed supply-chain bundle attached to the
GitHub release (see [../DEPLOYMENT.md](../DEPLOYMENT.md) §
"Supply-chain inventories per artifact and platform"). The bundle's
`CHECKSUMS.sha256` covers them, and the bundle itself is attested, so a
license inventory can be verified together with the image digest it describes.

The CI `image-scan` job runs the same license scan on the extract image on
every merge to `main` as a non-blocking smoke test, so a broken license
inventory is caught before a release depends on it.

## Scope notes

- The component SBOMs (`sbom.cdx.json`, attested in the registry) describe
  software identity; they do not assert license findings. The license SBOMs
  above are the license-bearing artifact for images.
- npm/Cargo-level copyleft handling (libvips LGPL as a dynamically loaded,
  replaceable shared library; MPL file-level components; CC-BY attribution for
  caniuse-lite) is documented in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) under "Artifact-specific
  compliance" and is unchanged by this document.
- Self-built images from these Dockerfiles inherit the same package set; the
  Trivy command above reproduces the license inventory for any build.
