FROM oven/bun:1.4.0 AS workspace
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile

FROM workspace AS runtime
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/runtime", "start"]

FROM workspace AS search
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/search", "start"]

FROM workspace AS gate
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/gate", "start"]

FROM workspace AS control
EXPOSE 3001
CMD ["bun", "run", "--cwd", "apps/control", "next", "dev", "--turbopack", "-H", "0.0.0.0", "-p", "3001"]
