# syntax=docker/dockerfile:1.7
# One image with the compiled game server and the static client build. See docs/docker.md.
#
# node:22-bookworm-slim (glibc) is used instead of Alpine: node:sqlite and the node-datachannel
# native addon are both available there, and node-datachannel 0.32.1 publishes napi-v8
# prebuilds for linux/amd64 and linux/arm64 (the musl builds would also exist, but Alpine keeps
# surprising native addons).
FROM node:22-bookworm-slim AS deps

# Some native addons fall back to node-gyp when a prebuild is unavailable; this stage is not
# part of the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Dependency manifests first, so source edits don't invalidate the install layer.
COPY package.json yarn.lock .yarnrc.yml ./
COPY server/package.json server/yarn.lock ./server/
COPY client/package.json client/yarn.lock ./client/
RUN yarn install --immutable \
    && yarn --cwd server install --immutable \
    && yarn --cwd client install --immutable


FROM deps AS build
WORKDIR /app
COPY . .
RUN yarn --cwd server build
# PUBLIC_URL=/ because the container serves the build at the root (the live site is mounted at
# /play, see client/craco.config.js). The server list is generated at startup, not baked in.
RUN PUBLIC_URL=/ \
    REACT_APP_SERVER_LIST_URL=/servers.json \
    CI=false \
    NODE_OPTIONS=--max-old-space-size=4096 \
    yarn --cwd client build
RUN node client/scripts/serve-build.mjs --precompress


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tar tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 tsps \
    && useradd --system --uid 10001 --gid tsps --create-home tsps

WORKDIR /app

# Only runtime files. Source, tests, docs and the dependency caches stay in the build stages.
COPY --from=build /app/client/build ./client/build
COPY --from=build /app/client/scripts ./client/scripts
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/plugins ./server/plugins
COPY --from=build /app/server/data ./server/data
COPY --from=build /app/server/scripts ./server/scripts
COPY --from=build /app/server/target.txt ./server/target.txt
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts ./scripts
COPY docker ./docker

# The admin page's plugin installer writes to server/plugins/imported; keep that on the volume.
RUN ln -sfn /data/plugins-imported /app/server/plugins/imported \
    && chmod +x /app/server/scripts/tsps-notify.mjs \
    && ln -sfn /app/server/scripts/tsps-notify.mjs /usr/local/bin/tsps-notify

# A named volume inherits this directory's ownership when Docker creates it, so the non-root
# user can write without a chown step. Bind mounts need their own permission handling.
RUN mkdir -p /data/saves /data/config /data/caches /data/logs /data/client /data/client-artwork /data/plugins-imported \
    && chown -R tsps:tsps /data

ENV NODE_ENV=production \
    TSPS_DATA_DIR=/data \
    TSPS_CACHE_DIR=/data/caches \
    TSPS_LOG_DIR=/data/logs \
    TSPS_SUPERVISED=1 \
    WEBSOCKET_PORT=43594 \
    CLIENT_PORT=3000 \
    WORLD_ADMIN_PORT=49600

VOLUME ["/data"]
EXPOSE 43594 3000

USER tsps

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBSOCKET_PORT||43594)+'/regions').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
