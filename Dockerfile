# Hear It Once — container image for Cloud Run (or any container host).
# SIMULATED PROTOTYPE: synthetic data only.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    PORT=8080 \
    HIO_DB_PATH=/tmp/hio.db \
    DEMO_MODE=true \
    ADAPTER_MODE=mock \
    POLICY_PROFILE=prototype-mock \
    INTENT_MODEL=rules \
    LIVE_PROVIDER=gemini \
    GOOGLE_CLOUD_LOCATION=us-central1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
USER node
EXPOSE 8080
# Migrates and seeds synthetic data automatically on first start.
CMD ["node", "node_modules/.bin/tsx", "--disable-warning=ExperimentalWarning", "src/server.ts"]
