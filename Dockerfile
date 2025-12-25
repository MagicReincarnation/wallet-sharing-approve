# =========================
# STAGE 1: build paxid (BENAR-BENAR STATIC)
# =========================
FROM golang:1.22-bookworm AS paxid-builder

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

# ⛔ JANGAN pakai make build (itu build DYNAMIC)
# ✅ build paxid STATIC manual
ENV CGO_ENABLED=0
ENV GOOS=linux
ENV GOARCH=amd64

RUN go build \
    -tags "netgo static" \
    -ldflags "-s -w -extldflags '-static'" \
    -o /build/paxid \
    ./cmd/paxid


# =========================
# STAGE 2: runtime
# =========================
FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=paxid-builder /build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "server.js"]
