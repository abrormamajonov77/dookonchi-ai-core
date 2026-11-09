FROM node:20-bookworm-slim

# Install Python3, pip and system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Install Node dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# 2. Install Python dependencies
COPY crypto-service/requirements.txt ./crypto-service/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r crypto-service/requirements.txt

# 3. Copy source files
COPY tsconfig.json ./
COPY src ./src/
COPY crypto-service ./crypto-service/

# 4. Build TypeScript
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start both Python crypto service and Node.js dookonchi bot simultaneously
CMD ["sh", "-c", "python3 crypto-service/bot.py & node dist/bot/index.js"]
