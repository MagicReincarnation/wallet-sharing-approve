'# =========================
# STAGE 1: build paxid + wasmvm
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

# build paxid + libwasmvm
RUN make build


# =========================
# STAGE 2: runtime
# =========================
FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# copy paxid binary
COPY --from=paxid-builder /build/paxi/build/paxid /usr/local/bin/paxid

# copy wasmvm shared library (INI PENYEBAB ERROR KAMU)
COPY --from=paxid-builder /build/paxi/build/libwasmvm.x86_64.so /usr/lib/libwasmvm.x86_64.so

# register shared library
RUN chmod +x /usr/local/bin/paxid \
    && ldconfig

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "server.js"]
