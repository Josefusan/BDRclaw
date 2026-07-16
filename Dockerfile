FROM node:22-slim

# tzdata: the BDR brain schedules on wall-clock TZ; slim images may lack it
# and Node silently falls back to UTC.
RUN apt-get update && apt-get install -y tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Full install: the build step (tsc) needs devDependencies. Pruned after build.
RUN npm ci

# NOTE: Playwright Chromium deliberately NOT installed. LinkedIn automation
# needs an authenticated browser session that only exists on the operator's
# machine — shipping Chromium here would add ~700MB for a code path that
# cannot run. Re-add `npx playwright install chromium --with-deps` (plus the
# lib* apt deps) if LinkedIn ever moves server-side.

COPY . .

RUN npm run build && npm prune --omit=dev

# SQLite, tokens, and session files live under /app/store — persistence is
# provided by a Railway Volume mounted there (Railway's builder rejects a
# Dockerfile VOLUME instruction; the mount is configured on the service).

EXPOSE 3000

ENV NODE_ENV=production \
    BDR_WEB_HOST=0.0.0.0

CMD ["node", "dist/index.js"]
