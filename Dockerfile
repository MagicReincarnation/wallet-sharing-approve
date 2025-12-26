# Stage 1: Build Paxid
FROM debian:bullseye AS builder

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    cmake \
    libsnappy-dev \
    zlib1g-dev \
    libbz2-dev \
    liblz4-dev \
    libzstd-dev \
    wget \
    curl \
    pkg-config \
    ca-certificates \
    libgflags-dev

# Install Go
ENV GOLANG_VERSION=1.24.2
RUN curl -LO https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go${GOLANG_VERSION}.linux-amd64.tar.gz && \
    ln -s /usr/local/go/bin/go /usr/bin/go

ENV PATH="/usr/local/go/bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy Go modules and download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY cmd ./cmd
COPY app ./app
COPY utils ./utils
COPY x ./x

# Build Paxid binary
RUN go build -mod=readonly -tags "pebbledb cosmwasm" -o paxid ./cmd/paxid

# Copy wasmvm library if diperlukan
RUN mkdir -p /root/.wasmvm/lib && \
    cp /root/go/pkg/mod/github.com/!cosm!wasm/wasmvm/*/internal/api/libwasmvm.x86_64.so /root/.wasmvm/lib/ || echo "wasmvm lib not found, skipped"

# Stage 2: Runtime image
FROM debian:bullseye-slim

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        libstdc++6 \
        libsnappy-dev \
        zlib1g-dev \
        libbz2-dev \
        libgflags-dev \
        liblz4-dev \
        libzstd-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /root/

# Copy Paxid binary
COPY --from=builder /app/paxid /usr/local/bin/paxid

# Copy wasmvm dynamic library
COPY --from=builder /root/.wasmvm/lib/libwasmvm* /usr/local/lib/
RUN echo "/usr/local/lib" > /etc/ld.so.conf.d/wasmvm.conf && ldconfig

# Expose typical Cosmos SDK ports
EXPOSE 26656 26657 1317 9090

# Default command to run Paxid node
CMD ["paxid", "start"]
