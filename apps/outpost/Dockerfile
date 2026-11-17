# Digests are updated by Dependabot (docker ecosystem)
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @atf/outpost build:node

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
RUN addgroup -S outpost && adduser -S -G outpost -u 10001 outpost \
 && mkdir -p /data && chown outpost:outpost /data \
 && printf '#!/bin/sh\nexec node /app/main.js "$@"\n' > /usr/local/bin/atf-outpost \
 && chmod 0755 /usr/local/bin/atf-outpost
COPY --from=build /repo/apps/outpost/dist-node/ /app/
USER 10001:10001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["atf-outpost", "healthcheck"]
ENTRYPOINT ["atf-outpost"]
CMD ["daemon"]
