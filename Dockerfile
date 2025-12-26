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

# Binary terinstall di $HOME/paxid/paxid berdasarkan Makefile Paxi
RUN cp /root/paxid/paxid /usr/local/bin/paxid \
    && chmod +x /usr/local/bin/paxid

# Mencari libwasmvm.so dan copy ke /usr/local/lib
# Kita gunakan wildcard agar mendukung x86_64 atau aarch64 (ARM)
RUN find /go/pkg/mod -name "libwasmvm.*.so" 2>/dev/null | head -n 1 | xargs -I {} cp {} /usr/local/lib/libwasmvm.x86_64.so || \
    find /root -name "libwasmvm.*.so" 2>/dev/null | head -n 1 | xargs -I {} cp {} /usr/local/lib/libwasmvm.x86_64.so || \
    find / -name "libwasmvm.*.so" 2>/dev/null | head -n 1 | xargs -I {} cp {} /usr/local/lib/libwasmvm.x86_64.so

# Verify di stage builder
RUN ldconfig && paxid version

# ===== Stage 2: Runtime image dengan Node.js =====
FROM node:18-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy paxid binary dan library dari builder stage
COPY --from=builder /usr/local/bin/paxid /usr/local/bin/paxid
COPY --from=builder /usr/local/lib/libwasmvm.x86_64.so /usr/local/lib/libwasmvm.x86_64.so

# --- FIX UTAMA: Daftarkan path library ke linker ---
RUN echo "/usr/local/lib" > /etc/ld.so.conf.d/libwasmvm.conf && ldconfig

# Set Environment Variable sebagai backup agar sistem pasti menemukan library
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH

# Verify paxid installation (Sekarang harusnya sukses)
RUN paxid version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]
