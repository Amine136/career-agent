# Minimal image for the Cloud Run ingestion worker.
# The default command runs both sources and retention; Cloud Run overrides it for scoring.
#   docker build -t career-agent .
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

WORKDIR /app

RUN npm install -g pnpm@11.22.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

CMD ["pnpm", "scheduler"]
