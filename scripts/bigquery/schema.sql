-- Northstar Bank demo dataset in BigQuery (SYNTHETIC data only).
-- setup.sh replaces PROJECT_ID and DATASET before running this file.
-- Reference tables are (re)loaded by setup.sh; event tables are written by the app during calls.

-- Demo clock: loaded timestamps are read as (timestamp + (now - anchor_at)).
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.dataset_meta` (anchor_at TIMESTAMP NOT NULL, generated_by STRING, note STRING);

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.customers` (
  customer_id STRING NOT NULL, customer_number STRING, full_name STRING, dob_hash STRING, phone_hash STRING, phone_masked STRING,
  email_masked STRING, segment STRING, account_standing STRING, contact_changed_at TIMESTAMP, created_at TIMESTAMP
) CLUSTER BY customer_id
OPTIONS (description = 'Synthetic Northstar Bank customers. Identity attributes are keyed hashes; nothing is real.');

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.cards` (
  card_id STRING NOT NULL, customer_id STRING NOT NULL, last4 STRING, network STRING, product STRING, holder_role STRING, holder_name STRING,
  status STRING, status_reason STRING, pan_sha256 STRING, created_at TIMESTAMP
) CLUSTER BY customer_id
OPTIONS (description = 'Cards. No card numbers are stored: pan_sha256 is a hash of the fictional demo number, used only to check what a caller reads out.');

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.transactions` (
  transaction_id STRING NOT NULL, customer_id STRING NOT NULL, card_id STRING, kind STRING, merchant_name STRING, merchant_category STRING,
  amount_minor INT64, currency STRING, txn_at TIMESTAMP, posted_at TIMESTAMP, status STRING, entry_mode STRING, auth_code STRING,
  related_payment_id STRING, source STRING, is_fraud_label BOOL
) CLUSTER BY customer_id, txn_at
OPTIONS (description = 'Card transactions. source = northstar_seed (scripted demo data) or kaggle_sparkov (history derived from the Kaggle Sparkov synthetic dataset, CC0).');

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.fraud_alerts` (
  alert_id STRING NOT NULL, customer_id STRING NOT NULL, card_id STRING, transaction_id STRING, alert_type STRING, risk_level STRING, status STRING,
  reported_card_status STRING, reported_amount_minor INT64, created_at TIMESTAMP
) CLUSTER BY customer_id;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.payments` (
  payment_id STRING NOT NULL, customer_id STRING NOT NULL, amount_minor INT64, currency STRING, initiated_at TIMESTAMP, channel STRING,
  source_account_masked STRING, status STRING, status_detail STRING, posted_at TIMESTAMP, expected_posting_date DATE, status_as_of TIMESTAMP
) CLUSTER BY customer_id;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.fees` (
  fee_id STRING NOT NULL, customer_id STRING NOT NULL, transaction_id STRING, fee_type STRING, amount_minor INT64, currency STRING,
  charged_at TIMESTAMP, reversed_at TIMESTAMP, reversal_reason STRING
) CLUSTER BY customer_id;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.declines` (
  decline_id STRING NOT NULL, customer_id STRING NOT NULL, card_id STRING, merchant_name STRING, amount_minor INT64, currency STRING,
  declined_at TIMESTAMP, reason_code STRING, customer_action STRING
) CLUSTER BY customer_id;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.dispute_rules` (
  rule_code STRING NOT NULL, reason STRING, description STRING, max_days_since_txn INT64, min_amount_minor INT64, allowed_entry_modes ARRAY<STRING>,
  requires_card_block BOOL, required_fields ARRAY<STRING>, automatable BOOL, active BOOL, version STRING
);

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.fee_policies` (rule_code STRING NOT NULL, fee_type STRING, reversible BOOL, description STRING, version STRING);

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.branches` (branch_id STRING, city STRING, area STRING, name STRING, address STRING, hours STRING, phone STRING, features STRING);

-- Knowledge: curated guidance, bank information, and the Bitext retail-banking FAQ (CDLA-Sharing-1.0).
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.kb_documents` (
  doc_id STRING NOT NULL, source STRING, title STRING, content STRING, categories ARRAY<STRING>, keywords ARRAY<STRING>, steps ARRAY<STRING>,
  rule_refs ARRAY<STRING>, intent STRING, sample_questions ARRAY<STRING>, version STRING, license STRING
);

-- Events written by the app during calls (streaming inserts).
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.operations` (
  op_id STRING, system STRING, operation STRING, idempotency_key STRING, payload_hash STRING, status STRING, failure_code STRING,
  downstream_status STRING, session_id STRING, customer_id STRING, created_at TIMESTAMP
) CLUSTER BY system, idempotency_key;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.card_status_events` (event_id STRING, customer_id STRING, card_id STRING, status STRING, reason STRING, session_id STRING, created_at TIMESTAMP) CLUSTER BY customer_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.replacement_orders` (order_id STRING, customer_id STRING, card_id STRING, delivery STRING, session_id STRING, created_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.dispute_submissions` (
  submission_id STRING, customer_id STRING, card_id STRING, transaction_id STRING, merchant STRING, amount_minor INT64, currency STRING,
  transaction_date DATE, reason_code STRING, case_id STRING, session_id STRING, created_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.fee_reversals` (reversal_id STRING, fee_id STRING, customer_id STRING, rule_code STRING, amount_minor INT64, currency STRING, session_id STRING, created_at TIMESTAMP) CLUSTER BY customer_id;
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET.demo_resets` (customer_id STRING, reset_at TIMESTAMP) CLUSTER BY customer_id;
