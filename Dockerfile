FROM node:18-alpine

WORKDIR /app

# Install dependencies
RUN apk add --no-cache \
    wget \
    curl \
    bash \
    ca-certificates \
    libc6-compat

# Download paxid binary dengan retry mechanism
RUN echo "📦 Downloading Paxi CLI..." && \
    PAXI_VERSION="v1.0.6" && \
    MAX_RETRIES=3 && \
    RETRY_COUNT=0 && \
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do \
        wget -q -O /tmp/paxid "https://github.com/paxi-web3/paxi/releases/download/${PAXI_VERSION}/paxid-linux-amd64" && break || \
        RETRY_COUNT=$((RETRY_COUNT+1)) && \
        echo "Retry $RETRY_COUNT/$MAX_RETRIES..." && \
        sleep 2; \
    done && \
    if [ ! -f /tmp/paxid ]; then \
        echo "❌ Failed to download paxid after $MAX_RETRIES attempts"; \
        exit 1; \
    fi && \
    chmod +x /tmp/paxid && \
    mv /tmp/paxid /usr/local/bin/paxid && \
    echo "✅ Binary moved to /usr/local/bin/paxid" && \
    ls -la /usr/local/bin/paxid && \
    /usr/local/bin/paxid version || echo "⚠️ Version check failed"

# Verify paxid is executable
RUN echo "🔍 Final verification..." && \
    which paxid && \
    file /usr/local/bin/paxid && \
    paxid version

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
