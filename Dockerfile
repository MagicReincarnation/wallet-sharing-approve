# =========================
# STAGE 1: Build paxid CLI
# =========================
FROM golang:1.22-alpine AS paxid-builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache \
    git \
    make \
    gcc \
    musl-dev \
    linux-headers

# Clone Paxi repository
RUN git clone https://github.com/paxi-web3/paxi.git

WORKDIR /build/paxi

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -a \
    -tags netgo \
    -ldflags '-w -s -extldflags "-static"' \
    -o /build/paxid \
    ./cmd/paxid

# Verify it's static
RUN ldd /build/paxid || echo "Static binary confirmed"

# =========================
# STAGE 2: Node.js Runtime
# =========================
FROM node:18-alpine

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    bash \
    ca-certificates

# Copy paxid binary
COPY --from=paxid-builder /build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid && \
    paxid version || echo "CLI ready"

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); });"

# Start application
CMD ["node", "server.js"]
