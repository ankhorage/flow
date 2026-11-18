# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build

ARG FLOW_VERSION
ARG SOURCE_REPOSITORY
ARG SOURCE_REVISION

LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${FLOW_VERSION}"

WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.node-esm.json tsconfig.test.json ./
RUN test -n "${FLOW_VERSION}" \
 && test "$(node -p "require('./package.json').version")" = "${FLOW_VERSION}" \
 && bun install --frozen-lockfile

COPY src ./src
RUN bun run build

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

ARG FLOW_VERSION
ARG SOURCE_REPOSITORY
ARG SOURCE_REVISION

LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${FLOW_VERSION}"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["./node_modules/.bin/flow", "worker", "health"]

ENTRYPOINT ["./node_modules/.bin/flow"]
