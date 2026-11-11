FROM node:20-trixie-slim

WORKDIR /app

# 1. System packages (python3 >= 3.12 for pandas_ta, pip, build essentials)
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

# 4. Copy TypeScript sources, config, and crypto-service, then build inside container
COPY tsconfig.json ./
COPY src ./src/
COPY crypto-service ./crypto-service/
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start service: Node.js supervises health-check server and crypto-service child process
CMD ["node", "dist/bot/index.js"]
