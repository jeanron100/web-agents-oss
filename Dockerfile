# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS runtime-base
# The upstream image can predate available Debian/npm security updates.
ARG NPM_VERSION=12.2.0
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund npm@${NPM_VERSION} && npm cache clean --force

FROM runtime-base AS web-build
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY web/ ./
RUN npm run build

FROM runtime-base AS dependencies
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM dependencies AS console-dependencies
# The Hub does not run Claude. Keep the bundled native CLI out of the console image.
RUN npm uninstall --no-save --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk

FROM runtime-base AS console
ENV NODE_ENV=production HOME=/var/lib/web-agents WA_DATA_DIR=/var/lib/web-agents/.web-agents \
    WA_HUB_CONFIG=/var/lib/web-agents/hub-config.json WA_ASSISTANT_MODEL_CONFIG=/var/lib/web-agents/assistant-model.json \
    WA_AUTH_ENABLED=1 WA_HUB_HOST=0.0.0.0 WA_HUB_PORT=8787 WA_WEB_ROOT=/app/web/dist \
    WA_VEC=0 WA_REDIS_ENABLED=0 WA_MONGO_ENABLED=0
WORKDIR /app
COPY --from=console-dependencies /app/server/node_modules ./server/node_modules
COPY server/*.js server/*.mjs server/package*.json ./server/
COPY server/repositories/ ./server/repositories/
COPY server/mcp/ ./server/mcp/
COPY --from=web-build /build/web/dist ./web/dist
RUN mkdir -p /var/lib/web-agents /run/web-agents/runner && chown -R node:node /var/lib/web-agents /run/web-agents/runner
# The control plane never installs packages or runs project CLIs.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD ["node","server/manage.mjs","health"]
CMD ["node","server/container-entry.mjs","console"]

FROM runtime-base AS runner
ARG CODEX_VERSION=0.159.2
ARG CLAUDE_VERSION=2.1.301
ARG KIMI_VERSION=2.2.0
ENV NODE_ENV=production HOME=/home/node WA_DATA_DIR=/home/node/.web-agents \
    WA_CONTAINER_RUNNER=1 WA_AGENT_HOST=0.0.0.0 WA_PROJECT_ROOT=/workspace \
    WA_AGENT_REQUIRE_TOKEN=1 WA_AGENT_TOKEN_FILE=/run/web-agents/runner/token \
    WA_WORKER_SLICE=0 WA_ENFORCE_WORKSPACE=1 WA_MEM_ADMIT=0 \
    PATH=/home/node/.local/bin:$PATH
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client tmux python3 python3-venv procps ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} @moonshot-ai/kimi-code@${KIMI_VERSION} \
    && npm cache clean --force && rm -rf /home/node/.npm /root/.npm
ENV KIMI_BIN=/usr/local/bin/kimi
WORKDIR /app
COPY --from=dependencies /app/server/node_modules ./server/node_modules
COPY server/*.js server/*.mjs server/package*.json ./server/
COPY server/repositories/ ./server/repositories/
COPY server/mcp/ ./server/mcp/
RUN mkdir -p /workspace /run/web-agents/runner && chown -R node:node /workspace /home/node /run/web-agents/runner
USER node
EXPOSE 8788
HEALTHCHECK --interval=15s --timeout=8s --start-period=60s CMD ["node","server/manage.mjs","health","runner"]
CMD ["node","server/container-entry.mjs","runner"]
