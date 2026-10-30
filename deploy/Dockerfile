# syntax=docker/dockerfile:1
# One Dockerfile, three runnable targets (see docker-compose.yml):
#   app     Next.js standalone server (production build)
#   ops     scheduler: morning brief, injury alerts, Claude CLI (talks to the app over HTTP, no database access)
#   worker  Chromium + Xvfb + noVNC + Playwright sync loop for Yahoo
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 CI=1
RUN npm install -g pnpm@12.9.1 && apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- all dependencies (dev included: tsx for the scripts, Playwright, vitest) ----
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- production build ----
FROM deps AS build
COPY . .
RUN pnpm build

# ---- app ----
FROM node:${NODE_VERSION}-bookworm-slim AS app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DB_FILE_NAME=/app/data/fantasy.sqlite TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# ---- ops (scheduler + Claude Code CLI) ----
FROM deps AS ops
ENV NODE_ENV=production HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude TZ=UTC
RUN npm install -g @anthropic-ai/claude-code && mkdir -p /home/node/.claude /work /app/data/reports /app/data/ops && chown -R node:node /home/node /work /app/data
COPY --chown=node:node . .
USER node
CMD ["node_modules/.bin/tsx", "scripts/ops-scheduler.ts"]

# ---- worker (Chromium, Xvfb, noVNC) ----
FROM deps AS worker
ENV NODE_ENV=production TZ=UTC DISPLAY=:99 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox procps fonts-liberation \
    && pnpm exec playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN chmod +x deploy/worker-entrypoint.sh && mkdir -p /profile /state
EXPOSE 6080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1
CMD ["deploy/worker-entrypoint.sh"]
