# Deployment guide

## Google Cloud Run (recommended for the hackathon demo)

The repo includes a `Dockerfile`; Cloud Build builds it for you, so you don't need Docker locally.

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
export REGION=asia-southeast1
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# Session-signing secret in Secret Manager (never in the repo or image)
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create hio-session-secret --data-file=-
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding hio-session-secret \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

# Build + deploy from the repo root
gcloud run deploy hear-it-once --source . --region=$REGION \
  --allow-unauthenticated --min-instances=1 --max-instances=1 --memory=512Mi \
  --set-secrets=SESSION_SECRET=hio-session-secret:latest
```

**Live voice (Lily):** also enable `aiplatform.googleapis.com`, grant the service account `roles/aiplatform.user`, add `--timeout=3600 --session-affinity` and the `LIVE_*`/`GOOGLE_CLOUD_*` variables — see [LILY_VOICE.md](LILY_VOICE.md).

### Keeping transcripts, cases and call memory across restarts

The database is one SQLite file on the container's local disk, and Cloud Run discards that disk on every restart and every new revision. Set `HIO_BACKUP_BUCKET` and the app saves a consistent copy of the database to that Cloud Storage bucket a few seconds after anything changes (and once more on shutdown), then restores the newest copy on start. Transcripts, Lily's saved facts for each call, cases, tickets and agent edits all live in that file, so they survive.

One-time setup, then deploy with `--min-instances=1 --no-cpu-throttling` and the `HIO_BACKUP_BUCKET` variable (see the deploy command in the README). The service account needs `roles/storage.objectAdmin` on the bucket only.

To start again with fresh demo data, delete the saved copy: `gcloud storage rm gs://BUCKET/hear-it-once/hio.db`. Limits: a crash (not a normal shutdown) can lose the last few seconds of writes, and the card number a caller is still reading out is held in memory only and is never saved. Locally, `HIO_BACKUP_DIR=./backup` does the same with a folder. Transcripts are kept for `TRANSCRIPT_RETENTION_DAYS` (default 365); the illustrative history from the seed is never purged.

Why `--max-instances=1`: the prototype keeps state in one SQLite file with in-process locking, so it must run as a single instance. `--min-instances=1` keeps that instance (and its demo data) alive between visits. Data lives in the container's `/tmp`, so it **resets on every new deploy or instance restart** — the app re-seeds the 18 scenarios and illustrative history automatically on start. That suits a demo; a persistent deployment needs Cloud SQL (see "Moving beyond the prototype").

Continuous deployment from GitHub: Cloud Run console → *hear-it-once* → **Set up continuous deployment** → GitHub → pick the repo and `main` → build type *Dockerfile*. Every push to `main` then rebuilds and redeploys.

Anyone with the URL can use every screen, including the admin reset (the staff sign-in is a demo role picker). Only synthetic data exists, but don't enter real card or customer details.


The prototype is designed to run locally. The steps below are for a **shared demo environment with synthetic data only**. They are not a production deployment: see PILOT_READINESS.md.

## Alternative: single VM host

```bash
# Node.js 22.13+ required
git clone <repo> hear-it-once && cd hear-it-once
npm ci
cp .env.example .env
#  edit .env:
#   SESSION_SECRET=<64 hex chars from: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
#   HOST=127.0.0.1         # keep bound to loopback; expose through the proxy only
#   HIO_DB_PATH=/var/lib/hear-it-once/hio.db
#   DEMO_MODE=true         # required for the simulated-phone OTP; refuses to start with NODE_ENV=production
npm run db:migrate
npm run db:seed
npm test                   # 130 tests should pass
npm start
```

### Run as a service (systemd example)

```ini
[Unit]
Description=Hear It Once (simulated prototype)
After=network.target

[Service]
WorkingDirectory=/opt/hear-it-once
EnvironmentFile=/opt/hear-it-once/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
User=hio
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/hear-it-once

[Install]
WantedBy=multi-user.target
```

### TLS reverse proxy (Caddy example)

```
demo.example.internal {
  reverse_proxy 127.0.0.1:3000
}
```

Terminate TLS at the proxy; restrict access (VPN/IP allow-list) because staff sign-in is a demo role picker.

## Container (optional)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i tsx@4
COPY . .
ENV HOST=0.0.0.0 HIO_DB_PATH=/data/hio.db
VOLUME /data
EXPOSE 3000
CMD ["npx", "tsx", "--disable-warning=ExperimentalWarning", "src/server.ts"]
```

Mount `/data` on a persistent (ideally encrypted) volume. Provide `SESSION_SECRET` via the orchestrator's secret store, not the image.

## Operations

| Task | Command |
|---|---|
| Upgrade schema | `npm run db:migrate` (idempotent, ordered SQL files in `src/db/migrations/`) |
| Reset demo data | `npm run db:reset` or dashboard admin reset |
| Backup | Stop the service or use `sqlite3 hio.db ".backup hio-backup.db"`; the DB is synthetic but backups keep demo history |
| Logs | JSON lines on stdout, redacted; ship to your log stack |
| Health | `GET /api/health` |
| Security checks | `npm run check:secrets`, `npm run audit:deps` |

## Moving beyond the prototype

Replacing mocks requires: implementing the adapter interfaces in `src/adapters/types.ts`, a real identity method, a managed database (the SQL is standard and portable to Postgres with minor changes), multi-instance session locking (e.g. DB row locks or a queue per call), SSO for staff, encryption at rest, and the approvals in PILOT_READINESS.md. Any non-`mock` `ADAPTER_MODE` automatically enforces human approval for all consequential actions.
