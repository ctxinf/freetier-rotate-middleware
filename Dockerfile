FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV CONFIG_PATH=./config.jsonc

WORKDIR /app

RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.jsonc ./config.jsonc

USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]