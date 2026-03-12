FROM node:22-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

RUN npm prune --omit=dev

FROM node:22-bookworm AS runtime

ENV NODE_ENV=production
# Default to the repo's JSONC config file unless overridden at runtime.
ENV CONFIG_PATH=./config.jsonc

WORKDIR /app

RUN mkdir -p /app/data \
  && chown -R node:node /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.jsonc ./config.jsonc

USER node

# config.jsonc defaults to port=3000 (can be overridden by env PORT).
EXPOSE 3000

CMD ["node", "dist/server.js"]
