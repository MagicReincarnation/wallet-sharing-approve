FROM node:18-alpine

WORKDIR /app

# Install dependencies dasar
RUN apk add --no-cache \
    wget \
    curl \
    bash \
    ca-certificates

# ===== SOLUSI 1: Download Pre-compiled Binary (RECOMMENDED) =====
# Gunakan binary release resmi dari GitHub
RUN PAXI_VERSION="v1.0.6" && \
    ARCH=$(uname -m) && \
    case $ARCH in \
        x86_64) BINARY="paxid-linux-amd64" ;; \
        aarch64) BINARY="paxid-linux-arm64" ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    wget -O /usr/local/bin/paxid "https://github.com/paxi-web3/paxi/releases/download/${PAXI_VERSION}/${BINARY}" && \
    chmod +x /usr/local/bin/paxid && \
    paxid version || echo "⚠️ paxid installation verification failed"

# ===== SOLUSI 2 (FALLBACK): Compile dari Source dengan Go 1.24 =====
# Uncomment jika solusi 1 gagal
# RUN apk add --no-cache git make gcc musl-dev && \
#     wget https://go.dev/dl/go1.24.2.linux-amd64.tar.gz && \
#     tar -C /usr/local -xzf go1.24.2.linux-amd64.tar.gz && \
#     rm go1.24.2.linux-amd64.tar.gz && \
#     export PATH=$PATH:/usr/local/go/bin && \
#     cd /tmp && \
#     git clone https://github.com/paxi-web3/paxi.git && \
#     cd paxi && \
#     git checkout v1.0.6 && \
#     /usr/local/go/bin/go build -mod=readonly -tags "cosmwasm pebbledb" -o /usr/local/bin/paxid ./cmd/paxid && \
#     chmod +x /usr/local/bin/paxid && \
#     cd / && rm -rf /tmp/paxi /usr/local/go && \
#     apk del git make gcc musl-dev

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Start app
CMD ["npm", "start"]
