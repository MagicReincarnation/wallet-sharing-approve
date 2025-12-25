# =========================
# STAGE 1: build paxid (Go >= 1.24.2)
# =========================
FROM golang:1.24-bookworm AS paxid-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# build paxid sesuai requirement go.mod
RUN make build


# =========================
# STAGE 2: runtime (node only)
# =========================
FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# copy paxid binary hasil build
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "server.js"]
