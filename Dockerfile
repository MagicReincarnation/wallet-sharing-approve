# Dockerfile untuk Multi-Dev Wallet Governance dengan Paxid CLI

FROM node:18-alpine

# Install dependencies untuk download dan execute binary
RUN apk add --no-cache \
    wget \
    ca-certificates \
    bash

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install --production

# Download dan install paxid CLI
RUN wget https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 -O /usr/local/bin/paxid \
    && chmod +x /usr/local/bin/paxid

# Verify paxid installation
RUN paxid version || echo "Warning: paxid not working"

# Copy application files
COPY . .

# Expose port
EXPOSE 8080

# Start application
CMD ["npm", "start"]
