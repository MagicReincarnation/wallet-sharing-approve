# ===== STAGE 1: BUILD PAXID =====
FROM golang:1.24-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache \
    git \
    make \
    gcc \
    musl-dev \
    linux-headers

# Clone Paxi repository
RUN git clone https://github.com/paxi-web3/paxi.git . && \
    git checkout v1.0.6

# Build paxid binary
RUN make install && \
    cp /root/go/bin/paxid /build/paxid || \
    cp $HOME/go/bin/paxid /build/paxid

# Verify binary
RUN /build/paxid version

# ===== STAGE 2: RUNTIME =====
FROM node:18-alpine

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    bash \
    ca-certificates

# Copy paxid binary from builder
COPY --from=builder /build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

# Verify paxid
RUN paxid version

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start app
CMD ["npm", "start"]
