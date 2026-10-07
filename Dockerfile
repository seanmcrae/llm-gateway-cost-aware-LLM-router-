FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
USER node
EXPOSE 8787
# Bind to all interfaces inside the container; publish the port explicitly with -p.
ENTRYPOINT ["node", "dist/bin/server.js", "--host", "0.0.0.0"]
