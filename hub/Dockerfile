FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/hub.db

EXPOSE 8787

CMD ["node", "src/index.js"]
