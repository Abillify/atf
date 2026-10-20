FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS workspace
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile

FROM workspace AS runtime
ARG GIT_SHA=unknown
ARG TARGETARCH
ARG INVENTORY_PLATFORM
RUN case "${TARGETARCH}" in amd64) actual_platform=linux-x64 ;; arm64) actual_platform=linux-arm64 ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && { test -z "${INVENTORY_PLATFORM}" || test "${INVENTORY_PLATFORM}" = "${actual_platform}"; } \
    && bun run supply-chain --inventory-root /workspace --output-dir /usr/share/doc/atf --platform "${actual_platform}" --artifact-kind image --artifact-name quickstart-runtime --git-sha "${GIT_SHA}"
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/runtime", "start"]

FROM workspace AS search
ARG GIT_SHA=unknown
ARG TARGETARCH
ARG INVENTORY_PLATFORM
RUN case "${TARGETARCH}" in amd64) actual_platform=linux-x64 ;; arm64) actual_platform=linux-arm64 ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && { test -z "${INVENTORY_PLATFORM}" || test "${INVENTORY_PLATFORM}" = "${actual_platform}"; } \
    && bun run supply-chain --inventory-root /workspace --output-dir /usr/share/doc/atf --platform "${actual_platform}" --artifact-kind image --artifact-name quickstart-search --git-sha "${GIT_SHA}"
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/search", "start"]

FROM workspace AS gate
ARG GIT_SHA=unknown
ARG TARGETARCH
ARG INVENTORY_PLATFORM
RUN case "${TARGETARCH}" in amd64) actual_platform=linux-x64 ;; arm64) actual_platform=linux-arm64 ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && { test -z "${INVENTORY_PLATFORM}" || test "${INVENTORY_PLATFORM}" = "${actual_platform}"; } \
    && bun run supply-chain --inventory-root /workspace --output-dir /usr/share/doc/atf --platform "${actual_platform}" --artifact-kind image --artifact-name quickstart-gate --git-sha "${GIT_SHA}"
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/gate", "start"]

FROM workspace AS control
ARG GIT_SHA=unknown
ARG TARGETARCH
ARG INVENTORY_PLATFORM
RUN case "${TARGETARCH}" in amd64) actual_platform=linux-x64 ;; arm64) actual_platform=linux-arm64 ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && { test -z "${INVENTORY_PLATFORM}" || test "${INVENTORY_PLATFORM}" = "${actual_platform}"; } \
    && bun run supply-chain --inventory-root /workspace --output-dir /usr/share/doc/atf --platform "${actual_platform}" --artifact-kind image --artifact-name quickstart-control --git-sha "${GIT_SHA}"
EXPOSE 3001
CMD ["bun", "run", "--cwd", "apps/control", "next", "dev", "--turbopack", "-H", "0.0.0.0", "-p", "3001"]

# Extract is the one target that needs external binaries: poppler-utils for PDF
# text extraction (pdftotext incl. -bbox-layout) and rasterisation, LibreOffice
# writer/calc/impress/draw for DOCX/XLSX/PPTX/VSDX. They are
# installed here rather than in the shared `workspace` stage so the other four
# images stay small — adding several hundred megabytes to Search, which sits on
# the query path, is exactly what having a separate converter service avoids.
#
# fonts-liberation is not optional: without a metric-compatible substitute for
# Arial and Times, LibreOffice reflows the document and the page breaks stop
# matching what a human sees when they open the file, which silently invalidates
# every page number in the output.
FROM workspace AS extract
ARG GIT_SHA=unknown
ARG TARGETARCH
ARG INVENTORY_PLATFORM
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      poppler-utils \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      libreoffice-draw-nogui \
      fonts-liberation \
      fonts-dejavu-core \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    # Fail the build, not the first conversion, if a converter is missing or
    # pdftotext cannot emit the -bbox-layout geometry the text path parses.
    && pdfinfo -v \
    && pdftotext -v \
    && { pdftotext -h 2>&1 | grep -q -- '-bbox-layout' \
         || { echo 'pdftotext lacks -bbox-layout' >&2; exit 1; }; } \
    && libreoffice --version
RUN case "${TARGETARCH}" in amd64) actual_platform=linux-x64 ;; arm64) actual_platform=linux-arm64 ;; *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && { test -z "${INVENTORY_PLATFORM}" || test "${INVENTORY_PLATFORM}" = "${actual_platform}"; } \
    && bun run supply-chain --inventory-root /workspace --output-dir /usr/share/doc/atf --platform "${actual_platform}" --artifact-kind image --artifact-name quickstart-extract --git-sha "${GIT_SHA}"
# LibreOffice and poppler both need a writable HOME, and the conversion pipeline
# writes rendered pages here.
ENV TEMP_DIR=/tmp/atf-extract
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/extract", "start"]
