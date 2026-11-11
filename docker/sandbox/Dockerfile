FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g near-sandbox@0.3.5
ENV HOME=/data
WORKDIR /data
EXPOSE 3030
# init once, then run; validator key ends up in /data/.near-sandbox/validator_key.json
CMD ["bash", "-c", "near-sandbox --home /data/.near-sandbox init && near-sandbox --home /data/.near-sandbox run"]

