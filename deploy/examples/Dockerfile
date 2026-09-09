FROM oven/bun:1.4.0 AS workspace
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
