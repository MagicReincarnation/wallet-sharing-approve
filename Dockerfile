# =========================
# STAGE 1: build paxid (STATIC wasmvm)
# =========================
FROM golang:1.24-bookworm AS paxid-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    ca-certificates \
    clang \
    llvm \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# ⚠️ build paxid dengan STATIC wasmvm (INI KUNCI)
ENV LEDGER_ENABLED=false
ENV BUILD_TAGS=netgo,static
ENV CGO_ENABLED=0

RUN make build


# =========================
# STAGE 2: runtime (TANPA wasmvm)
# =========================
FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid

RUN chmod +x /usr/local/bin/paxid

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "server.js"]
