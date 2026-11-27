# Reuse the existing standalone room entry point instead of duplicating room
# logic in the image. `tsx` runs the TypeScript sources directly; the compose
# healthcheck and the web proxy both rely on `GET /health` and `/ws`.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY server ./server
# The room layer imports the shared Minesweeper engine and wire contract from
# `src/`; copy them so tsx can resolve the same modules the host tests use.
COPY src ./src
# Bind every interface inside the compose network; the host only sees the
# published loopback port from compose.yaml.
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "server/room/main.ts"]
