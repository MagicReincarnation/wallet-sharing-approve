# =========================
# STAGE 1 — BUILD paxid (STATIC WASMVM)
# =========================
FROM golang:1.24 AS paxid-builder

WORKDIR /build

# deps untuk wasmvm
RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# clone source
RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# build paxid + wasmvm (STATIC)
ENV CGO_ENABLED=1
ENV GOOS=linux
ENV GOARCH=amd64

RUN make build


# =========================
# STAGE 2 — NODE RUNTIME
# =========================
FROM node:18-slim

WORKDIR /app

# install runtime deps YANG DIBUTUHKAN paxid
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libwasmvm-dev \
    && rm -rf /var/lib/apt/lists/*

# copy paxid binary
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

# verify (build-time)
RUN ldd /usr/local/bin/paxid || true
RUN paxid version || true

# node app
COPY package*.json ./
RUN npm install --production
COPY . .

CMD ["node", "server.js"]
