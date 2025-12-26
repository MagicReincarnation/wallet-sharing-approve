# =========================
# STAGE 1: Download paxid binary
# =========================
FROM alpine:latest AS paxid-downloader

WORKDIR /build

RUN apk add --no-cache wget

# Download pre-built binary from GitHub releases
RUN wget https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 \
    && chmod +x paxid-linux-amd64 \
    && mv paxid-linux-amd64 paxid

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
COPY --from=paxid-downloader /build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid

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
