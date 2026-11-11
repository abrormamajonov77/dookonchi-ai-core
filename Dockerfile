FROM node:20-bookworm-slim

WORKDIR /app

# 1. System runtime dependencies required by Prisma (OpenSSL & CA certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node packages and generate Prisma Client
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install && npx prisma generate

# 3. Copy TypeScript sources & config only (crypto-service isolated/frozen) and build inside container
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/bot/index.js"]
