# Node 24 runtime image for the ffEventNotify bot.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

CMD ["node", "src/main.ts"]
