FROM node:18 AS builder

WORKDIR /usr/src/app

COPY package.json yarn.lock* package-lock.json* ./

# Install dependencies
RUN npm install

COPY . .

# Build the plugin
RUN npm run build

FROM nginx:1.21-alpine

COPY --from=builder /usr/src/app/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 9443

CMD ["nginx", "-g", "daemon off;"]
