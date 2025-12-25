# =========================
# STAGE 1: build paxid
# =========================
FROM golang:1.22-bookworm AS paxid-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/paxi-web3/paxi.git
WORKDIR /build/paxi

# build binary paxid
RUN make build


# =========================
# STAGE 2: runtime (node + paxid)
# =========================
FROM node:18-bookworm-slim

WORKDIR /app

# install runtime deps (TANPA libwasmvm-dev)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# copy paxid binary saja
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

# copy node deps
COPY package*.json ./
RUN npm install --production

# copy source app
COPY . .

CMD ["node", "index.js"]
