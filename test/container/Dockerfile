FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY test/container/client.ts ./test/container/client.ts
COPY test/fixtures/fileRuntimeModule.ts ./test/fixtures/fileRuntimeModule.ts

ENTRYPOINT ["bun", "src/cli/standalone.ts"]
