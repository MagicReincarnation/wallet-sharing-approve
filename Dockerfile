# Stage 1: Build Paxid dari source
FROM golang:1.24-bullseye AS builder

# Install dependencies build
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
    libgflags-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy go.mod & go.sum dari repo kamu
COPY go.mod go.sum ./

# Download module dependencies
RUN go mod download

# Copy semua source code
COPY . .

# Build binary Paxid dengan tags yang diperlukan
RUN go build -mod=readonly -tags "pebbledb cosmwasm" -o /usr/local/bin/paxid ./cmd/paxid

# Stage 2: Runtime image
FROM debian:bullseye-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        libstdc++6 \
        libsnappy-dev \
        zlib1g-dev \
        libbz2-dev \
        libgflags-dev \
        liblz4-dev \
        libzstd-dev \
        curl \
        ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /root/

# Copy binary dari builder
COPY --from=builder /usr/local/bin/paxid /usr/local/bin/paxid

# Pastikan executable
RUN chmod +x /usr/local/bin/paxid

# Expose Cosmos SDK default ports
EXPOSE 26656 26657 1317 9090

# Default command
CMD ["paxid", "start"]
