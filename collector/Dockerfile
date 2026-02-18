FROM --platform=linux/amd64 golang:1.23-alpine AS builder

WORKDIR /workspace

COPY go.mod ./
COPY go.sum ./
COPY cmd ./cmd
COPY internal ./internal

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-s -w' -o /usr/local/bin/ovn-collector ./cmd/ovn-collector

FROM --platform=linux/amd64 alpine:3.20

WORKDIR /app

RUN addgroup -S app && adduser -S -G app app

COPY --from=builder /usr/local/bin/ovn-collector /usr/local/bin/ovn-collector
COPY fixtures ./fixtures
COPY api ./api

ENV SNAPSHOT_DIR=/app/fixtures/snapshots

EXPOSE 8090
USER app

ENTRYPOINT ["/usr/local/bin/ovn-collector"]
