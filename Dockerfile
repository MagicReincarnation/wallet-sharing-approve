FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git make gcc musl-dev
WORKDIR /src
RUN git clone https://github.com/paxi-web3/paxi.git .
RUN make build

FROM node:20-alpine
RUN apk add --no-cache bash ca-certificates libc6-compat
COPY --from=builder /src/build/paxid /usr/local/bin/paxid
WORKDIR /app
COPY . .
RUN npm install --production
CMD ["node","server.js"]
