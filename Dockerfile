FROM node:22-slim

# Playwright Chromium dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install chromium --with-deps

COPY . .

RUN npm run build

# Store directory for SQLite, tokens, session files
VOLUME ["/app/store"]

EXPOSE 3000

ENV NODE_ENV=production \
    BDR_WEB_HOST=0.0.0.0

CMD ["node", "dist/index.js"]
