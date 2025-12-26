FROM debian:bullseye-slim

# Install dependency dasar
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    jq \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /root/

# Download binary Paxi langsung
RUN curl -L -o paxid https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 \
    && chmod +x paxid \
    && mv paxid /usr/local/bin/

# Pastikan paxid bisa di PATH
ENV PATH="/usr/local/bin:${PATH}"

# Expose port Cosmos SDK / Paxi
EXPOSE 26656 26657 1317 9090

# Default command untuk jalankan node
CMD ["paxid", "start"]
