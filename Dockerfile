# =========================
# STAGE 1 — BUILD paxid (GO TOOLCHAIN FIX)
# =========================
FROM golang:1.24 AS paxid-builder

WORKDIR /build

# clone source
RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# pastikan go version cocok (go.mod minta >= 1.24.2)
RUN go version

# build paxid
RUN make build


# =========================
# STAGE 2 — RUNTIME NODE (RINGKAS & AMAN)
# =========================
FROM node:18-slim

# deps minimal
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
 && rm -rf /var/lib/apt/lists/*

# copy binary paxid SAJA
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

# sanity check (build-time)
RUN paxid version || which paxid

# =========================
# APP
# =========================
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

CMD ["node", "index.js"]
