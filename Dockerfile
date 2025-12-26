# ===== STAGE 1: BUILD PAXID =====
FROM alpine:3.19 AS builder

WORKDIR /build

# Install Go 1.24.2 dan build tools
RUN apk add --no-cache \
    git \
    make \
    gcc \
    musl-dev \
    linux-headers \
    wget \
    tar

# Install Go 1.24.2 manually
RUN wget https://go.dev/dl/go1.24.2.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go1.24.2.linux-amd64.tar.gz && \
    rm go1.24.2.linux-amd64.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/go"

# Clone dan build Paxi
RUN git clone https://github.com/paxi-web3/paxi.git . && \
    git checkout v1.0.6 && \
    make install && \
    cp /root/go/bin/paxid /build/paxid || cp $HOME/go/bin/paxid /build/paxid

# Verify
RUN /build/paxid version

# ===== STAGE 2: RUNTIME =====
FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache bash ca-certificates

# Copy binary dari builder
COPY --from=builder /build/paxid /usr/local/bin/paxid
RUN chmod +x /usr/local/bin/paxid && paxid version

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app
COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
