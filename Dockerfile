FROM node:20-bookworm-slim

WORKDIR /app

# 1. System packages (python3, pip, git, build essentials for pandas_ta)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    python3-dev \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node packages
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install

# 3. Install Python packages
COPY crypto-service/requirements.txt ./crypto-service/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r crypto-service/requirements.txt

# 4. Copy precompiled dist and crypto-service
COPY dist ./dist/
COPY crypto-service ./crypto-service/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start both services: python in background, node in foreground
CMD ["sh", "-c", "python3 crypto-service/bot.py & node dist/bot/index.js"]
