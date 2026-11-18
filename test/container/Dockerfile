FROM oven/bun:1.4.2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY test/container/client.ts ./test/container/client.ts
COPY test/fixtures/fileRuntimeModule.ts ./test/fixtures/fileRuntimeModule.ts

ENTRYPOINT ["bun", "src/cli/standalone.ts"]
