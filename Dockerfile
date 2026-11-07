# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
WORKDIR /app
RUN chown node:node /app

FROM base AS dependencies
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci --no-audit --no-fund \
    && sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.mirror-lock-hash

FROM dependencies AS development
USER root
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER node
COPY --chown=node:node . .
ENV NODE_ENV=development NEXT_PUBLIC_BASE_PATH=""
EXPOSE 3000
ENTRYPOINT ["sh", "docker/development-entrypoint.sh"]
CMD ["npm", "run", "dev"]

FROM dependencies AS build
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY --chown=node:node . .
RUN npm run build

FROM base AS production
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/dist/standalone/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS test
COPY --from=base /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p /tmp/mirror-fixtures \
    && espeak-ng -v en-us -s 145 -w /tmp/mirror-fixtures/question.wav "Please look at my hair and tell me what you can see."
ENV CI=1
CMD ["sh", "-c", "npm run typecheck && npm test && npm run test:e2e"]
