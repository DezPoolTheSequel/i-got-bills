FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Bills/settings JSON files are written here. Mount this as a volume in
# Container Manager so the data survives container restarts/updates.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3001

CMD ["node", "server.js"]
