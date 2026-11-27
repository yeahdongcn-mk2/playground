# Build the static site exactly like `npm run build` does on the host. The
# artifact stays `dist/` and is copied into nginx's document root below.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

# Serve the built site. The nginx image's entrypoint renders
# /etc/nginx/templates/default.conf.template with envsubst at startup, so the
# compose-provided DEMO_ROOM_URL becomes the same-origin `/ws` proxy target.
FROM nginx:1.27-alpine
COPY docker/demo/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/demo/web-entrypoint.sh /usr/local/bin/demo-web-entrypoint.sh
RUN chmod +x /usr/local/bin/demo-web-entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html
ENTRYPOINT ["/usr/local/bin/demo-web-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
EXPOSE 80
