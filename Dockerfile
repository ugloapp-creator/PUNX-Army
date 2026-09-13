FROM node:22-alpine
WORKDIR /app
COPY server/ ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "room-server.js"]
