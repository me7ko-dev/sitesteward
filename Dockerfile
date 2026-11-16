# sitesteward – zero runtime dependencies, so the image is just Node + the source.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY locales ./locales

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

# exec form: node is PID 1 and receives SIGTERM from `docker stop` for a clean shutdown
CMD ["node", "bin/sitesteward.js"]
