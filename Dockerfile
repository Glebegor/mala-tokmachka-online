# One image for every backend service; pick the service with --build-arg SERVICE=<auth|lobby|game|profile|gateway>
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps/client/package.json ./apps/client/package.json
RUN npm ci --include=dev --include-workspace-root --workspace=@sw/auth --workspace=@sw/lobby --workspace=@sw/game --workspace=@sw/gateway --workspace=@sw/profile --workspace=@sw/core --workspace=@sw/kit

COPY mods ./mods
ENV SW_DATA_DIR=/data
VOLUME /data

ARG SERVICE
ENV SERVICE=${SERVICE}
CMD ["sh", "-c", "exec node_modules/.bin/tsx services/$SERVICE/src/main.ts"]
