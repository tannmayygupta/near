# Quiet Treasury worker (API + agent loop). Build: docker build -t qt-worker .
# Run:   docker run --rm -p 8787:8787 -v qt-data:/data --env-file <your-env-file> qt-worker
# The image contains NO secrets: pass them as environment variables (see docs/DEPLOY.md). tsx is a devDependency, so install everything, then set NODE_ENV.
FROM node:24-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY worker ./worker
ENV NODE_ENV=production \
    PORT=8787 \
    STATE_DB=/data/worker.sqlite \
    NODE_NO_WARNINGS=1
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "worker/index.ts"]
