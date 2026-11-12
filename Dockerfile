FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY web/ ./web/
ENV HOST=0.0.0.0 PORT=4000 CASEGRAPH_DB_PATH=/data/casegraph.sqlite
VOLUME ["/data"]
EXPOSE 4000
CMD ["npm", "start"]
