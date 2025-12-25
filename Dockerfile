# =========================
# STAGE 1 — BUILD paxid
# =========================
FROM golang:1.22-bullseye AS paxid-builder

WORKDIR /build

RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# build paxid
RUN make build


# =========================
# STAGE 2 — RUNTIME NODE
# =========================
FROM node:18-slim

# install minimal runtime deps
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# copy paxid binary ONLY
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

# sanity check
RUN paxid version || which paxid

# =========================
# APP
# =========================
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

CMD ["node", "index.js"]
