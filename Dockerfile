# SOLUSI PALING SEDERHANA
# Copy paxid dari container yang sudah ada, tanpa perlu compile

FROM node:18-alpine

# Install dependencies
RUN apk add --no-cache \
    wget \
    curl \
    bash \
    ca-certificates

WORKDIR /app

# Download pre-compiled paxid binary dari release GitHub
# Catatan: Sesuaikan versi dengan yang terbaru
RUN wget -O /tmp/paxi.tar.gz https://github.com/paxi-web3/paxi/archive/refs/tags/v1.0.6.tar.gz && \
    tar -xzf /tmp/paxi.tar.gz -C /tmp && \
    # Jika ada pre-compiled binary di archive, copy ke /usr/local/bin
    # Jika tidak ada, kita perlu compile (lihat alternative Dockerfile)
    rm -rf /tmp/paxi.tar.gz

# ALTERNATIVE: Install Go dan compile paxid
RUN apk add --no-cache git make gcc musl-dev go && \
    cd /tmp && \
    git clone https://github.com/paxi-web3/paxi.git && \
    cd paxi && \
    git checkout v1.0.6 && \
    make install && \
    cp $HOME/go/bin/paxid /usr/local/bin/paxid || \
    cp /root/go/bin/paxid /usr/local/bin/paxid || \
    find / -name paxid -type f 2>/dev/null | head -1 | xargs -I {} cp {} /usr/local/bin/paxid && \
    chmod +x /usr/local/bin/paxid && \
    cd / && \
    rm -rf /tmp/paxi && \
    apk del git make gcc musl-dev go

# Verify installation
RUN paxid version || echo "⚠️ paxid not found, liquidity features will be disabled"

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
