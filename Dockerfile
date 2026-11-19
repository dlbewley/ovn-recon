# syntax=docker/dockerfile:1
# Webpack runs only on the build host arch. Per-target images only add nginx + dist (avoids QEMU arm64 webpack on amd64 CI).
FROM --platform=$BUILDPLATFORM node:26 AS builder

WORKDIR /usr/src/app

COPY package.json yarn.lock* package-lock.json* ./

RUN npm ci

COPY . .

RUN npm run build

# Pin an exact nginx release and bump it deliberately: a minor tag such as 1.21-alpine stops
# receiving updates once nginx moves to the next branch, and this image sat on 1.21.6 (Alpine 3.15)
# for years. 1.31.9 fixes the nginx2root CVEs (CVE-2026-123007, -123633, -123634, -121810, -113425).
FROM --platform=$TARGETPLATFORM nginx:1.31.9-alpine

# Support running as arbitrary user which belogs to the root group
RUN chmod g+rwx /var/cache/nginx /var/run /var/log/nginx && \
    chgrp -R root /var/cache/nginx && \
    sed -i.bak 's/^user/#user/' /etc/nginx/nginx.conf && \
    addgroup nginx root

COPY --from=builder /usr/src/app/dist /usr/share/nginx/html

ENV OVN_RECON_NGINX_ERROR_LOG_LEVEL=info
ENV OVN_RECON_NGINX_ACCESS_LOG=off
ENV NGINX_ENVSUBST_FILTER=^OVN_RECON_NGINX_

# COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 9443

CMD ["nginx", "-g", "daemon off;"]
