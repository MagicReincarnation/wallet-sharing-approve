# ================= BASE IMAGE =================
FROM node:18-bullseye

# ================= DEPENDENCY OS =================
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    ca-certificates \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ================= INSTALL GOLANG =================
ENV GO_VERSION=1.22.0
RUN wget https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz && \
    rm go${GO_VERSION}.linux-amd64.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

# ================= BUILD paxid FROM SOURCE =================
WORKDIR /opt

RUN git clone https://github.com/paxi-web3/paxi.git && \
    cd paxi && \
    make build && \
    cp build/paxid /usr/local/bin/paxid && \
    chmod +x /usr/local/bin/paxid

# ================= VALIDASI =================
RUN paxid version || which paxid

# ================= APP =================
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]
