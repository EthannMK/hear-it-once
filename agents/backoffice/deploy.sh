#!/usr/bin/env bash
# Deploy the read-only back-office agent (Google ADK) to Vertex AI Agent Engine and connect the CRM to it.
# Run in Cloud Shell from the repository root, AFTER scripts/bigquery/setup.sh:
#   bash agents/backoffice/deploy.sh
set -euo pipefail
PROJECT="${PROJECT:-hear-it-once}"
AGENT_LOCATION="${AGENT_LOCATION:-us-central1}"     # where the agent runs (Agent Engine region)
BQ_LOCATION="${BQ_LOCATION:-asia-southeast1}"
DATASET="${DATASET:-northstar_bank}"
SERVICE="${SERVICE:-hear-it-once}"; RUN_REGION="${RUN_REGION:-asia-southeast1}"
BUCKET="${BUCKET:-gs://${PROJECT}-agent-staging}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
if [ "$PROJECT" = "ulink-claimflow" ]; then echo "Refusing to touch project ulink-claimflow." >&2; exit 1; fi
gcloud config set project "$PROJECT" >/dev/null
NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

echo "== 1/5 APIs"; gcloud services enable aiplatform.googleapis.com bigquery.googleapis.com storage.googleapis.com
echo "== 2/5 Read-only views for the agent"
# The views read columns the app's schema adds over time. Applying the schema first (every
# statement in it creates or alters only if needed, and nothing is dropped or emptied) means this
# works on a dataset built by an older setup.sh, rather than failing on a column that is not there.
SCHEMA="$ROOT/scripts/bigquery/schema.sql"
if [ -f "$SCHEMA" ]; then
  # BigQuery limits how often a table's definition may change, so a busy dataset can refuse the
  # first attempt. Waiting and trying again costs a minute and saves a confusing failure.
  for attempt in 1 2 3; do
    if sed "s/PROJECT_ID/$PROJECT/g; s/\.DATASET\./.$DATASET./g" "$SCHEMA" | bq query --location="$BQ_LOCATION" --use_legacy_sql=false --quiet; then break; fi
    [ "$attempt" = 3 ] && { echo "The dataset could not be brought up to date. Run: bash scripts/bigquery/setup.sh" >&2; exit 1; }
    echo "  BigQuery is busy; waiting 20 s and trying again ($attempt of 3)"; sleep 20
  done
fi
sed "s/PROJECT_ID/$PROJECT/g; s/\.DATASET\./.$DATASET./g" "$HERE/views.sql" | bq query --location="$BQ_LOCATION" --use_legacy_sql=false --quiet
echo "== 3/5 Staging bucket $BUCKET"
gsutil ls -b "$BUCKET" >/dev/null 2>&1 || gsutil mb -l "$AGENT_LOCATION" "$BUCKET"
echo "== 4/5 Permissions: the agent can read the dataset and run queries; Cloud Run can call the agent"
AE_SA="service-${NUM}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
gcloud beta services identity create --service=aiplatform.googleapis.com --project="$PROJECT" >/dev/null 2>&1 || true
for role in roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$AE_SA" --role="$role" --condition=None --quiet >/dev/null || echo "  (will retry this grant after the first deploy creates $AE_SA)"
done
RUN_SA="$(gcloud run services describe "$SERVICE" --region "$RUN_REGION" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
[ -z "$RUN_SA" ] && RUN_SA="${NUM}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUN_SA" --role=roles/aiplatform.user --condition=None --quiet >/dev/null
echo "== 5/5 Deploying the agent (5 to 10 minutes the first time)"
python3 -m venv "$HOME/.venv-backoffice" && . "$HOME/.venv-backoffice/bin/activate"
pip install -q -r "$HERE/requirements.txt"
OUT="$(cd "$HERE" && python3 deploy.py --project "$PROJECT" --location "$AGENT_LOCATION" --bucket "$BUCKET" --dataset "$DATASET" --bq-location "$BQ_LOCATION" | tee /dev/stderr)"
RES="$(echo "$OUT" | sed -n 's/^AGENT_ENGINE_RESOURCE=//p' | tail -1)"
if [ -z "$RES" ]; then
  echo
  echo "The agent did not come up. Its own logs say why:" >&2
  gcloud logging read 'resource.type="aiplatform.googleapis.com/ReasoningEngine" severity>=WARNING' \
    --project="$PROJECT" --limit=30 --freshness=2h --format='value(timestamp,severity,textPayload,jsonPayload.message)' >&2 || true
  exit 1
fi
for role in roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$AE_SA" --role="$role" --condition=None --quiet >/dev/null || true
done
echo
echo "Agent: $RES"
echo "Connect the CRM to it (keeps all other settings):"
echo "  gcloud run services update $SERVICE --region=$RUN_REGION --update-env-vars=AGENT_ENGINE_RESOURCE=$RES"
