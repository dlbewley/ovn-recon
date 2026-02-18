FROM node:18 AS builder

WORKDIR /usr/src/app

COPY package.json yarn.lock* package-lock.json* ./

# Install dependencies
RUN npm install

COPY . .

# Build the plugin
RUN npm run build

FROM nginx:1.21-alpine

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
