# build stage: install all deps and compile typescript to dist/
FROM node:24-slim AS build

WORKDIR /app

# --ignore-scripts: skips the husky "prepare" hook, there is no .git in the image
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json app.ts ./
COPY bin ./bin
COPY lib ./lib
COPY routes ./routes
COPY scripts ./scripts
RUN npm run build

# runtime stage: production deps + compiled js only
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# data/ holds database.sqlite, log/ holds the optional --log-key file. both are bind
# mounted from the host in docker-compose.yml, so this stays root: a non-root user
# would not be able to write to a host directory docker created for the mount.
RUN mkdir -p data log

ENV PORT=3000
EXPOSE 3000

CMD ["node", "./dist/bin/www.js"]
