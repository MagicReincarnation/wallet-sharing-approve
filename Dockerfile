# Stage 1: Build Paxid
FROM debian:bullseye AS builder

RUN apt-get update && apt-get install -y \
    build-essential git cmake libsnappy-dev zlib1g-dev libbz2-dev \
    liblz4-dev libzstd-dev wget curl pkg-config ca-certificates libgflags-dev

# Install Go
ENV GOLANG_VERSION=1.24.2
RUN curl -LO https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go${GOLANG_VERSION}.linux-amd64.tar.gz && \
    ln -s /usr/local/go/bin/go /usr/bin/go
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Build Paxid binary
RUN go build -mod=readonly -tags "pebbledb cosmwasm" -o paxid ./cmd/paxid

# Copy wasmvm library
RUN mkdir -p /root/.wasmvm/lib && \
    cp /root/go/pkg/mod/github.com/!cosm!wasm/wasmvm/*/internal/api/libwasmvm.x86_64.so /root/.wasmvm/lib/

# Stage 2: Runtime
FROM debian:bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libstdc++6 libsnappy-dev zlib1g-dev libbz2-dev libgflags-dev liblz4-dev libzstd-dev curl ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Paxid binary dan wasm library
COPY --from=builder /app/paxid /usr/local/bin/paxid
COPY --from=builder /root/.wasmvm/lib/libwasmvm* /usr/local/lib/
RUN chmod +x /usr/local/bin/paxid
RUN echo "/usr/local/lib" > /etc/ld.so.conf.d/wasmvm.conf && ldconfig

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Copy server code
WORKDIR /app/server
COPY package*.json ./
RUN npm install --production
COPY . .

# Expose ports
EXPOSE 8080 26656 26657 1317 9090

# Default command
CMD ["node", "server.js"]
