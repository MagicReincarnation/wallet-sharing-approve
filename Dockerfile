# ===== Dockerfile (WAJIB, FORMAT BENAR UNTUK RAILWAY) =====

# 1. Base image
FROM node:20-bullseye

# 2. Install dependency OS yang dibutuhkan paxid
RUN apt-get update \
 && apt-get install -y wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 3. Install paxid CLI
RUN wget -O /usr/local/bin/paxid \
    https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 \
 && chmod +x /usr/local/bin/paxid

# (opsional tapi DISARANKAN) verifikasi saat build
RUN paxid version

# 4. Set working directory
WORKDIR /app

# 5. Copy & install node dependencies
COPY package*.json ./
RUN npm install

# 6. Copy seluruh source code
COPY . .

# 7. Expose port (samakan dengan server.js)
EXPOSE 8080

# 8. Start app
CMD ["node", "server.js"]
