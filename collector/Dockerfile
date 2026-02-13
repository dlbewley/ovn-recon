FROM golang:1.23-alpine AS builder

WORKDIR /workspace

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

RUN go build -trimpath -ldflags='-s -w' -o /usr/local/bin/ovn-collector ./cmd/ovn-collector

FROM alpine:3.20

RUN addgroup -S app && adduser -S -G app app

COPY --from=builder /usr/local/bin/ovn-collector /usr/local/bin/ovn-collector

EXPOSE 8090
USER app

ENTRYPOINT ["/usr/local/bin/ovn-collector"]
