# Node 24 runtime image for the ffEventNotify bot.
FROM node:24-slim

ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV NODE_ENV=production FFE_GIT_SHA=$GIT_SHA FFE_BUILD_TIME=$BUILD_TIME
LABEL org.opencontainers.image.revision=$GIT_SHA org.opencontainers.image.created=$BUILD_TIME
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src

RUN mkdir -p /data && chown node:node /data
EXPOSE 3480
VOLUME ["/data"]
USER node

CMD ["node", "src/main.ts"]
