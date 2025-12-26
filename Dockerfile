# ===== DOCKERFILE UNTUK SERVER.JS PAXI GOVERNANCE =====
FROM node:20-alpine

# Install dependency OS
RUN apk add --no-cache \
  bash \
  curl \
  ca-certificates \
  libc6-compat

# Install Paxi CLI
RUN curl -L https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 \
  -o /usr/local/bin/paxid && \
  chmod +x /usr/local/bin/paxid

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Environment default
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "start"]
