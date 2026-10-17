#!/usr/bin/env bash
# Build the Northstar Bank dataset in BigQuery and connect the Cloud Run service to it.
# Run in Google Cloud Shell from the repository root:   bash scripts/bigquery/setup.sh
#
# Safe to re-run: tables are created if missing and reference data is reloaded. Events the app
# wrote during calls are kept (set RESET_EVENTS=1 to clear them).
#
# Optional inputs:
#   Kaggle:  kaggle.com > Settings > API Tokens > Generate New Token, then save it with
#              echo 'YOUR_TOKEN' > ~/.kaggle/access_token && chmod 600 ~/.kaggle/access_token
#            (a legacy ~/.kaggle/kaggle.json also works).
#            Without it the Kaggle history step is skipped and everything else still works.
#   SKIP_EMBEDDINGS=1  skip the Vertex AI embedding model (knowledge search then uses keywords).
set -euo pipefail

PROJECT="${PROJECT:-hear-it-once}"
LOCATION="${LOCATION:-asia-southeast1}"       # BigQuery dataset location
DATASET="${DATASET:-northstar_bank}"
SERVICE="${SERVICE:-hear-it-once}"            # Cloud Run service
RUN_REGION="${RUN_REGION:-asia-southeast1}"
CONNECTION="${CONNECTION:-vertex_ai}"
WORK="${WORK:-$HOME/northstar-bq}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ "$PROJECT" = "ulink-claimflow" ]; then echo "Refusing to touch project ulink-claimflow." >&2; exit 1; fi
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
mkdir -p "$WORK/export"
gcloud config set project "$PROJECT" >/dev/null

step "1/8 Enabling APIs (BigQuery, BigQuery Connection, Vertex AI)"
gcloud services enable bigquery.googleapis.com bigqueryconnection.googleapis.com aiplatform.googleapis.com

step "2/8 Dataset $PROJECT:$DATASET in $LOCATION"
bq --location="$LOCATION" show --format=none "$PROJECT:$DATASET" 2>/dev/null \
  || bq --location="$LOCATION" mk --dataset --description "Northstar Bank demo data (synthetic). Used live by the Hear It Once agent." "$PROJECT:$DATASET"
sed "s/PROJECT_ID/$PROJECT/g; s/\.DATASET\./.$DATASET./g" "$HERE/schema.sql" | bq query --location="$LOCATION" --use_legacy_sql=false --quiet
if [ "${RESET_EVENTS:-0}" = "1" ]; then
  for t in operations card_status_events replacement_orders dispute_submissions fee_reversals demo_resets; do
    bq query --location="$LOCATION" --use_legacy_sql=false --quiet "TRUNCATE TABLE \`$PROJECT.$DATASET.$t\`" || true
  done
fi

step "3/8 Exporting the synthetic Northstar seed"
( cd "$ROOT" && { [ -d node_modules ] || npm ci --silent; } && npx tsx --disable-warning=ExperimentalWarning scripts/bigquery/export-seed.ts "$WORK/export" )

step "4/8 Kaggle card transactions (Sparkov, CC0)"
KAGGLE_OK=0
if [ -f "$HOME/.kaggle/access_token" ] || [ -f "$HOME/.kaggle/access_token.txt" ] || [ -n "${KAGGLE_API_TOKEN:-}" ] || [ -f "$HOME/.kaggle/kaggle.json" ] || [ -n "${KAGGLE_USERNAME:-}" ]; then
  python3 -m pip install --user --quiet --upgrade "kaggle>=1.8.0"
  if [ ! -f "$WORK/fraudTrain.csv" ]; then
    KAGGLE_BIN="$(python3 -m site --user-base)/bin/kaggle"; command -v kaggle >/dev/null && KAGGLE_BIN=kaggle
    "$KAGGLE_BIN" datasets download kartik2112/fraud-detection -f fraudTrain.csv -p "$WORK" --force
    ( cd "$WORK" && { [ -f fraudTrain.csv.zip ] && unzip -o -q fraudTrain.csv.zip && rm -f fraudTrain.csv.zip || true; } )
  fi
  python3 -I "$HERE/prepare_kaggle.py" "$WORK/fraudTrain.csv" "$WORK/export" && KAGGLE_OK=1
else
  echo "No Kaggle token found (~/.kaggle/access_token or ~/.kaggle/kaggle.json). Skipping Kaggle history."
fi

step "5/8 Bitext retail-banking FAQ (Hugging Face, CDLA-Sharing-1.0)"
BITEXT_OK=0
if [ ! -f "$WORK/bitext.csv" ]; then
  curl -fsSL -o "$WORK/bitext.csv" "https://huggingface.co/datasets/bitext/Bitext-retail-banking-llm-chatbot-training-dataset/resolve/main/bitext-retail-banking-llm-chatbot-training-dataset.csv" || rm -f "$WORK/bitext.csv"
fi
if [ -f "$WORK/bitext.csv" ]; then python3 -I "$HERE/prepare_bitext.py" "$WORK/bitext.csv" "$WORK/export" && BITEXT_OK=1; else echo "Bitext download failed. Skipping the FAQ."; fi

step "6/8 Loading tables"
load() { # table file [replace|append]
  local mode="--replace"; [ "${3:-replace}" = "append" ] && mode="--noreplace"
  bq load --location="$LOCATION" --quiet $mode --source_format=NEWLINE_DELIMITED_JSON "$PROJECT:$DATASET.$1" "$2"
  echo "  $1 <- $(basename "$2")"
}
for t in dataset_meta customers cards dispute_rules fee_policies branches payments fees declines transactions fraud_alerts kb_documents; do
  load "$t" "$WORK/export/$t.json"
done
[ "$KAGGLE_OK" = "1" ] && load transactions "$WORK/export/transactions_kaggle.json" append && load fraud_alerts "$WORK/export/fraud_alerts_kaggle.json" append
[ "$BITEXT_OK" = "1" ] && load kb_documents "$WORK/export/kb_documents_bitext.json" append
if [ "$KAGGLE_OK" = "1" ]; then
  # The full Kaggle dataset as an anonymised reference table for analysis (no card numbers, names, addresses or dates of birth).
  bq load --location="$LOCATION" --quiet --replace --autodetect --source_format=CSV --skip_leading_rows=1 "$PROJECT:$DATASET.kaggle_raw" "$WORK/fraudTrain.csv"
  bq query --location="$LOCATION" --use_legacy_sql=false --quiet "
    CREATE OR REPLACE TABLE \`$PROJECT.$DATASET.reference_card_transactions\`
    OPTIONS (description = 'Kaggle kartik2112/fraud-detection (Sparkov simulator, CC0), anonymised: card numbers, names, street, dob and trans_num removed.') AS
    SELECT trans_date_trans_time AS transacted_at, REGEXP_REPLACE(merchant, r'^fraud_', '') AS merchant, category, amt AS amount,
           gender, city, state, city_pop, job, is_fraud = 1 AS is_fraud
    FROM \`$PROJECT.$DATASET.kaggle_raw\`;
    DROP TABLE \`$PROJECT.$DATASET.kaggle_raw\`;"
  echo "  reference_card_transactions (anonymised Kaggle dataset)"
fi

step "7/8 Knowledge embeddings (Vertex AI text-embedding-005 through BigQuery ML)"
EMBED_OK=0
if [ "${SKIP_EMBEDDINGS:-0}" != "1" ]; then
  bq show --connection "$PROJECT.$LOCATION.$CONNECTION" >/dev/null 2>&1 \
    || bq mk --connection --location="$LOCATION" --project_id="$PROJECT" --connection_type=CLOUD_RESOURCE "$CONNECTION"
  CONN_SA="$(bq show --format=json --connection "$PROJECT.$LOCATION.$CONNECTION" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cloudResource"]["serviceAccountId"])')"
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CONN_SA" --role=roles/aiplatform.user --condition=None --quiet >/dev/null
  echo "  waiting 60 s for the new permission to take effect"; sleep 60
  if bq query --location="$LOCATION" --use_legacy_sql=false --quiet "
      CREATE OR REPLACE MODEL \`$PROJECT.$DATASET.embedding_model\` REMOTE WITH CONNECTION \`$PROJECT.$LOCATION.$CONNECTION\` OPTIONS (ENDPOINT = 'text-embedding-005');
      CREATE OR REPLACE TABLE \`$PROJECT.$DATASET.kb_embeddings\` AS
      SELECT doc_id, source, title, body AS content, categories, keywords, steps, rule_refs, version, ml_generate_embedding_result AS embedding
      FROM ML.GENERATE_EMBEDDING(MODEL \`$PROJECT.$DATASET.embedding_model\`,
        (SELECT doc_id, source, title, content AS body, categories, keywords, steps, rule_refs, version,
                CONCAT(title, '\n', ARRAY_TO_STRING(IFNULL(sample_questions, []), ' | '), '\n', content) AS content
         FROM \`$PROJECT.$DATASET.kb_documents\`),
        STRUCT('RETRIEVAL_DOCUMENT' AS task_type, TRUE AS flatten_json_output))
      WHERE ml_generate_embedding_status = '';"; then
    EMBED_OK=1; echo "  kb_embeddings ready"
  else
    echo "  Embeddings could not be created. Knowledge search will use keywords (set BQ_EMBEDDING_MODEL=off)."
  fi
fi

step "8/8 Letting the Cloud Run service read and write the dataset"
RUN_SA="$(gcloud run services describe "$SERVICE" --region "$RUN_REGION" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
if [ -z "$RUN_SA" ]; then RUN_SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"; fi
for role in roles/bigquery.jobUser roles/bigquery.dataEditor roles/bigquery.connectionUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUN_SA" --role="$role" --condition=None --quiet >/dev/null
done
echo "  $RUN_SA can now run queries, read and write $DATASET, and use the embedding connection"

EMB_ENV="BQ_EMBEDDING_MODEL=$DATASET.embedding_model"; [ "$EMBED_OK" = "1" ] || EMB_ENV="BQ_EMBEDDING_MODEL=off"
cat <<EOF

Done. Row counts:
$(bq query --location="$LOCATION" --use_legacy_sql=false --format=pretty --quiet "
  SELECT 'customers' t, COUNT(*) n FROM \`$PROJECT.$DATASET.customers\` UNION ALL
  SELECT 'transactions', COUNT(*) FROM \`$PROJECT.$DATASET.transactions\` UNION ALL
  SELECT 'kb_documents', COUNT(*) FROM \`$PROJECT.$DATASET.kb_documents\`")

Switch the app to BigQuery (the current mock mode stays available; remove ADAPTER_MODE to go back):

  gcloud run services update $SERVICE --region=$RUN_REGION \\
    --update-env-vars=ADAPTER_MODE=bigquery,BQ_PROJECT=$PROJECT,BQ_DATASET=$DATASET,BQ_LOCATION=$LOCATION,$EMB_ENV
EOF
