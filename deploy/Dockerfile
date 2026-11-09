# This file is part of Lotproof.
# SPDX-License-Identifier: Apache-2.0
# Demo service image. The contract must be compiled before building
# (`yarn compile`), because the proving keys live in contract/managed.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json yarn.lock .npmrc ./
# vite-node runs the TypeScript service, so dev dependencies are needed at runtime.
RUN yarn install --frozen-lockfile --non-interactive --production=false && yarn cache clean
ENV NODE_ENV=production
COPY tsconfig.json ./
COPY contract ./contract
COPY src ./src
COPY server ./server
COPY web ./web
# testkit-js writes its own log files under logs/.
RUN mkdir -p data midnight-level-db logs && chown -R node:node /app/data /app/midnight-level-db /app/logs
USER node
EXPOSE 8787
CMD ["node_modules/.bin/vite-node", "server/index.ts"]
