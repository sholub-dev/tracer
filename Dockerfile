FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/ios/package.json packages/ios/

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter '!@tracer-sh/ios'
COPY . .
RUN pnpm build

# The two native runtime packages, at the versions in the lockfile. Both ship prebuilt binaries, so no install script runs.
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter tracer-sh

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY package.json ./
COPY --from=deps /src/node_modules node_modules
COPY bin/ bin/
COPY skills/ skills/
COPY --from=build /src/packages/server/dist packages/server/dist
COPY --from=build /src/packages/web/dist packages/web/dist
ENV NODE_ENV=production TRACER_HOME=/data
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3579
CMD ["node","--import","./packages/server/dist/gcp-secrets.js","packages/server/dist/index.js"]
