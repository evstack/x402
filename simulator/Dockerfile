FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

ENTRYPOINT ["bun", "run", "src/index.ts"]
