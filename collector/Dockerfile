# syntax=docker/dockerfile:1
# Builder runs on the build host arch (fast); binary targets the image arch (buildx sets TARGET*).
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace

COPY go.mod ./
COPY go.sum ./
COPY cmd ./cmd
COPY internal ./internal

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /usr/local/bin/ovn-collector ./cmd/ovn-collector

FROM --platform=$TARGETPLATFORM alpine:3.20

WORKDIR /app

RUN addgroup -S app && adduser -S -G app app

COPY --from=builder /usr/local/bin/ovn-collector /usr/local/bin/ovn-collector
COPY fixtures ./fixtures
COPY api ./api

ENV SNAPSHOT_DIR=/app/fixtures/snapshots

EXPOSE 8090
USER app

ENTRYPOINT ["/usr/local/bin/ovn-collector"]
