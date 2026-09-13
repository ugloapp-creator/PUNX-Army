# Root Dockerfile for the PUNX ARMY room server.
#
# It lives at the repo root because Fly's GitHub deploy only looks here,
# but everything it needs is in server/. Zero dependencies, so there is no
# install step and nothing to cache.
FROM node:22-alpine
WORKDIR /app

# Copy the CONTENTS of server/ into /app, so room-server.js sits at /app.
COPY server/ ./

ENV PORT=8080
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "room-server.js"]
