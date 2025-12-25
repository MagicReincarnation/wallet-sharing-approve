# ===== Dockerfile FINAL (ANTI RAILWAY NIXPACKS) =====
# PASTIKAN FILE INI BENAR-BENAR DIPAKAI

FROM node:20-bullseye

RUN apt-get update \
 && apt-get install -y wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# install paxid ke PATH PASTI
RUN wget -O /usr/local/bin/paxid \
    https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 \
 && chmod +x /usr/local/bin/paxid

# debug keras: FAIL BUILD kalau paxid gak ada
RUN which paxid && paxid version

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
