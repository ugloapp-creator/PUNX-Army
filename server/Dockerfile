# Zero dependencies, so no install step and nothing to cache.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
# Run unprivileged.
USER node
CMD ["node", "room-server.js"]
