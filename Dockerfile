# Stage 1: Base image dengan Node.js
FROM node:18-slim

# Install dependencies untuk download dan extract
RUN apt-get update && apt-get install -y \
wget \
ca-certificates \
&& rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Download dan install Paxid CLI
RUN wget -q https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 -O /usr/local/bin/paxid \
&& chmod +x /usr/local/bin/paxid \
&& paxid version

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