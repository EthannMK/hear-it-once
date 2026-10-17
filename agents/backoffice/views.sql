-- Read-only views for the back-office agent (ADK on Vertex AI Agent Engine).
-- The agent may only query these views (checked on every query with a BigQuery dry run).
-- They leave out the identity hashes (dob_hash, phone_hash, pan_sha256) and auth codes, and they
-- apply the demo clock, so "3 days ago" in the seed reads as 3 days ago today.
-- PROJECT_ID and DATASET are replaced by deploy.sh.

CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_customers` AS
SELECT c.customer_id, c.customer_number, c.full_name, c.segment, c.account_standing, c.phone_masked,
       TIMESTAMP_ADD(c.created_at, INTERVAL m.s SECOND) AS customer_since
FROM `PROJECT_ID.DATASET.customers` c
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m;

-- Card status is the loaded status overlaid with the newest status event written during calls.
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_cards` AS
SELECT k.card_id, k.customer_id, k.last4, k.network, k.product, k.holder_role,
       IFNULL(e.status, k.status) AS status, IFNULL(e.reason, k.status_reason) AS status_reason, e.created_at AS status_changed_at
FROM `PROJECT_ID.DATASET.cards` k
LEFT JOIN (
  SELECT card_id, ARRAY_AGG(STRUCT(status, reason, created_at) ORDER BY created_at DESC LIMIT 1)[OFFSET(0)].*
  FROM `PROJECT_ID.DATASET.card_status_events` ev
  LEFT JOIN (SELECT customer_id, MAX(reset_at) AS reset_at FROM `PROJECT_ID.DATASET.demo_resets` GROUP BY customer_id) rs USING (customer_id)
  WHERE ev.created_at > IFNULL(rs.reset_at, TIMESTAMP '1970-01-01')  -- the same demo reset the app applies
  GROUP BY card_id
) e USING (card_id);

CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_transactions` AS
SELECT t.transaction_id, t.customer_id, t.card_id, t.kind, t.merchant_name, t.merchant_category,
       t.amount_minor / 100 AS amount, t.currency, TIMESTAMP_ADD(t.txn_at, INTERVAL m.s SECOND) AS txn_at,
       TIMESTAMP_ADD(t.posted_at, INTERVAL m.s SECOND) AS posted_at, t.status, t.entry_mode, t.source, t.is_fraud_label,
       -- Card-system detail. The authorisation code stays out: it is not needed to answer a question
       -- and it is one of the things that should not travel.
       t.mcc, t.merchant_city, t.merchant_country, t.network_ref, t.acquirer
FROM `PROJECT_ID.DATASET.transactions` t
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m;

CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_fraud_alerts` AS
SELECT a.alert_id, a.customer_id, a.card_id, a.transaction_id, a.alert_type, a.risk_level, a.status,
       a.reported_amount_minor / 100 AS reported_amount, TIMESTAMP_ADD(a.created_at, INTERVAL m.s SECOND) AS created_at
FROM `PROJECT_ID.DATASET.fraud_alerts` a
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m;

CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_payments` AS
SELECT p.payment_id, p.customer_id, p.amount_minor / 100 AS amount, p.currency, TIMESTAMP_ADD(p.initiated_at, INTERVAL m.s SECOND) AS initiated_at,
       p.channel, p.status, p.status_detail, TIMESTAMP_ADD(p.posted_at, INTERVAL m.s SECOND) AS posted_at
FROM `PROJECT_ID.DATASET.payments` p
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m;

-- Fees, with reversals made during calls applied.
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_fees` AS
SELECT f.fee_id, f.customer_id, f.transaction_id, f.fee_type, f.amount_minor / 100 AS amount, f.currency,
       TIMESTAMP_ADD(f.charged_at, INTERVAL m.s SECOND) AS charged_at,
       COALESCE(r.created_at, TIMESTAMP_ADD(f.reversed_at, INTERVAL m.s SECOND)) AS reversed_at,
       COALESCE(r.rule_code, f.reversal_reason) AS reversal_reason
FROM `PROJECT_ID.DATASET.fees` f
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m
LEFT JOIN (
  SELECT fv.fee_id, MAX(fv.created_at) AS created_at, ANY_VALUE(fv.rule_code) AS rule_code
  FROM `PROJECT_ID.DATASET.fee_reversals` fv
  LEFT JOIN (SELECT customer_id, MAX(reset_at) AS reset_at FROM `PROJECT_ID.DATASET.demo_resets` GROUP BY customer_id) rs USING (customer_id)
  WHERE fv.created_at > IFNULL(rs.reset_at, TIMESTAMP '1970-01-01')
  GROUP BY fv.fee_id
) r USING (fee_id);

CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_declines` AS
SELECT d.decline_id, d.customer_id, d.card_id, d.merchant_name, d.amount_minor / 100 AS amount, d.currency,
       TIMESTAMP_ADD(d.declined_at, INTERVAL m.s SECOND) AS declined_at, d.reason_code, d.customer_action
FROM `PROJECT_ID.DATASET.declines` d
CROSS JOIN (SELECT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND) AS s FROM `PROJECT_ID.DATASET.dataset_meta`) m;

-- What happened during calls (written live by the voice agent's back end).
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_disputes` AS
SELECT submission_id, customer_id, card_id, transaction_id, merchant, amount_minor / 100 AS amount, currency, transaction_date, reason_code, case_id, created_at
FROM `PROJECT_ID.DATASET.dispute_submissions`;
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_card_events` AS
SELECT customer_id, card_id, status, reason, created_at FROM `PROJECT_ID.DATASET.card_status_events`;
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_replacements` AS
SELECT order_id, customer_id, card_id, delivery, created_at FROM `PROJECT_ID.DATASET.replacement_orders`;

-- Rules, policies and knowledge.
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_dispute_rules` AS SELECT * FROM `PROJECT_ID.DATASET.dispute_rules`;
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_fee_policies` AS SELECT * FROM `PROJECT_ID.DATASET.fee_policies`;
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_branches` AS SELECT * FROM `PROJECT_ID.DATASET.branches`;
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET.agent_knowledge` AS
SELECT doc_id, source, title, content, categories, rule_refs, version FROM `PROJECT_ID.DATASET.kb_documents`;
