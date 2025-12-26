# ===== Stage 1: Build Paxid dari source =====
FROM golang:1.24-bullseye AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
git \
make \
gcc \
g++ \
&& rm -rf /var/lib/apt/lists/*

# Clone dan build Paxi
WORKDIR /build
RUN git clone https://github.com/paxi-web3/paxi.git \
&& cd paxi \
&& git checkout latest-main \
&& make install

# Binary akan terinstall di $HOME/paxid/paxid (sesuai Makefile)
# Copy binary ke lokasi standard
RUN cp /root/paxid/paxid /usr/local/bin/paxid \
&& chmod +x /usr/local/bin/paxid

# Verify binary works
RUN paxid version

# ===== Stage 2: Runtime image dengan Node.js =====
FROM node:18-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
ca-certificates \
&& rm -rf /var/lib/apt/lists/*

# Copy paxid binary dari builder stage
COPY --from=builder /usr/local/bin/paxid /usr/local/bin/paxid

# Verify paxid installation
RUN paxid version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]