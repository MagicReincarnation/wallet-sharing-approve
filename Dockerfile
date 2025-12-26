# Stage 1: gunakan image Debian slim
FROM debian:bullseye-slim

# Install dependency dasar
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    jq \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Buat folder kerja
WORKDIR /root/

# Install Paxi prebuilt binary via script resmi
RUN curl -sL https://raw.githubusercontent.com/paxi-web3/paxi/main/scripts/cli_install.sh | bash

# Pastikan paxid ada di PATH
ENV PATH="/root/.paxi/bin:${PATH}"

# Expose port yang biasa digunakan Cosmos SDK / Paxi node
EXPOSE 26656 26657 1317 9090

# Default command untuk jalankan node
CMD ["paxid", "start"]
