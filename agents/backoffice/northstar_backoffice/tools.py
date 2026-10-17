"""Read-only BigQuery tools for the Northstar back-office agent.

Every tool reads; none can change anything. Free-form SQL goes through `run_sql`, which:
  * accepts a single SELECT statement only (checked by a BigQuery dry run, not by regex),
  * only reads the `agent_*` views (plus the anonymised Kaggle reference table), checked from the
    dry run's list of referenced tables, so the identity hashes in the base tables stay out of reach,
  * refuses queries that would scan more than MAX_BYTES, and returns at most MAX_ROWS rows.
"""
from __future__ import annotations

import datetime as _dt
import decimal as _dec
import os
import re
from typing import Any

from google.cloud import bigquery

PROJECT = os.environ.get("BQ_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT", "hear-it-once")
DATASET = os.environ.get("BQ_DATASET", "northstar_bank")
BQ_LOCATION = os.environ.get("BQ_LOCATION", "asia-southeast1")
MAX_BYTES = int(os.environ.get("AGENT_MAX_BYTES", str(2 * 1024**3)))
MAX_ROWS = 50

ALLOWED_TABLES = {
    "agent_customers", "agent_cards", "agent_transactions", "agent_fraud_alerts", "agent_payments",
    "agent_fees", "agent_declines", "agent_disputes", "agent_card_events", "agent_replacements",
    "agent_dispute_rules", "agent_fee_policies", "agent_branches", "agent_knowledge",
    "reference_card_transactions",
}

_client: bigquery.Client | None = None


def _bq() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT, location=BQ_LOCATION)
    return _client


def set_client_for_tests(client: Any) -> None:
    global _client
    _client = client


def _plain(v: Any) -> Any:
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()
    if isinstance(v, _dec.Decimal):
        return float(v)
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    return v


def _rows(job: Any, limit: int = MAX_ROWS) -> list[dict[str, Any]]:
    out = []
    for i, row in enumerate(job.result(max_results=limit)):
        if i >= limit:
            break
        out.append({k: _plain(v) for k, v in dict(row.items()).items()})
    return out


def _params(**kw: Any) -> list[Any]:
    out = []
    for k, v in kw.items():
        t = "INT64" if isinstance(v, int) and not isinstance(v, bool) else "STRING"
        out.append(bigquery.ScalarQueryParameter(k, t, v))
    return out


def _query(sql: str, **params: Any) -> list[dict[str, Any]]:
    cfg = bigquery.QueryJobConfig(
        query_parameters=_params(**params),
        default_dataset=f"{PROJECT}.{DATASET}",
        maximum_bytes_billed=MAX_BYTES,
    )
    return _rows(_bq().query(sql, job_config=cfg))


_ID = re.compile(r"^[A-Za-z0-9_-]{3,40}$")


def _check_id(name: str, value: str) -> str | None:
    return None if value and _ID.match(value) else f"{name} must look like CUS-1001 (letters, digits, - or _)."


# --------------------------------------------------------------------------- tools


def run_sql(sql: str) -> dict:
    """Run one read-only BigQuery SELECT over the bank's agent views and return up to 50 rows.

    Use the views by bare name (the default dataset is set): agent_customers, agent_cards,
    agent_transactions (amount in currency units, txn_at), agent_fraud_alerts, agent_payments,
    agent_fees, agent_declines, agent_disputes, agent_card_events, agent_replacements,
    agent_dispute_rules, agent_fee_policies, agent_branches, agent_knowledge, and
    reference_card_transactions (anonymised public Kaggle data: category, amount, is_fraud).

    Args:
        sql: A single GoogleSQL SELECT (or WITH ... SELECT) statement.

    Returns:
        {"status": "ok", "rows": [...], "row_count": n, "sql": sql} or {"status": "refused"/"error", "reason": ...}.
    """
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        return {"status": "refused", "reason": "No SQL was given."}
    if len(text) > 4000:
        return {"status": "refused", "reason": "The query is too long (4,000 characters at most)."}
    if ";" in text:
        return {"status": "refused", "reason": "Only one statement is allowed."}
    client = _bq()
    base = dict(default_dataset=f"{PROJECT}.{DATASET}", use_legacy_sql=False)
    try:
        dry = client.query(text, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False, **base))
    except Exception as e:  # invalid SQL, unknown table, permission
        return {"status": "error", "reason": str(e)[:400]}
    if (getattr(dry, "statement_type", None) or "SELECT").upper() != "SELECT":
        return {"status": "refused", "reason": "Only SELECT queries are allowed. This agent cannot change anything."}
    bad = []
    for t in getattr(dry, "referenced_tables", None) or []:
        if t.project != PROJECT or t.dataset_id != DATASET or t.table_id not in ALLOWED_TABLES:
            bad.append(f"{t.project}.{t.dataset_id}.{t.table_id}")
    if bad:
        return {"status": "refused", "reason": "Only the agent_* views can be read. Not allowed: " + ", ".join(bad)}
    scanned = int(getattr(dry, "total_bytes_processed", 0) or 0)
    if scanned > MAX_BYTES:
        return {"status": "refused", "reason": f"The query would scan {scanned / 1e9:.1f} GB; the limit is {MAX_BYTES / 1e9:.1f} GB. Add filters."}
    try:
        job = client.query(text, job_config=bigquery.QueryJobConfig(maximum_bytes_billed=MAX_BYTES, **base))
        rows = _rows(job)
    except Exception as e:
        return {"status": "error", "reason": str(e)[:400]}
    return {"status": "ok", "rows": rows, "row_count": len(rows), "sql": text}


def customer_snapshot(customer_id: str) -> dict:
    """Everything the back office knows about one customer, in one call.

    Args:
        customer_id: The bank's customer id, e.g. "CUS-1001".

    Returns:
        Profile, cards (with live status), 12-month activity, disputes, fee reversals, open fraud
        alerts, recent declines and the last 8 transactions.
    """
    if err := _check_id("customer_id", customer_id):
        return {"status": "refused", "reason": err}
    q = lambda sql: _query(sql, cid=customer_id)  # noqa: E731
    profile = q("SELECT customer_id, customer_number, full_name, segment, account_standing, customer_since FROM agent_customers WHERE customer_id = @cid")
    if not profile:
        return {"status": "not_found", "reason": f"No customer {customer_id}."}
    return {
        "status": "ok",
        "profile": profile[0],
        "cards": q("SELECT card_id, last4, network, product, holder_role, status, status_reason, status_changed_at FROM agent_cards WHERE customer_id = @cid"),
        "last_12_months": q(
            """SELECT COUNT(*) AS transactions, ROUND(SUM(IF(kind = 'purchase', amount, 0)), 2) AS spend,
                      COUNT(DISTINCT merchant_name) AS merchants, COUNTIF(is_fraud_label) AS labelled_fraud
               FROM agent_transactions WHERE customer_id = @cid AND txn_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)""")[0],
        "top_categories": q(
            """SELECT IFNULL(merchant_category, 'other') AS category, COUNT(*) AS n, ROUND(SUM(amount), 2) AS spend
               FROM agent_transactions WHERE customer_id = @cid AND kind = 'purchase' GROUP BY 1 ORDER BY spend DESC LIMIT 3"""),
        "disputes": q("SELECT transaction_id, merchant, amount, reason_code, created_at FROM agent_disputes WHERE customer_id = @cid ORDER BY created_at DESC LIMIT 5"),
        "fees": q("SELECT fee_type, amount, charged_at, reversed_at, reversal_reason FROM agent_fees WHERE customer_id = @cid ORDER BY charged_at DESC LIMIT 6"),
        "open_fraud_alerts": q("SELECT alert_id, transaction_id, alert_type, risk_level, reported_amount, created_at FROM agent_fraud_alerts WHERE customer_id = @cid AND status = 'open'"),
        "recent_declines": q("SELECT merchant_name, amount, declined_at, reason_code FROM agent_declines WHERE customer_id = @cid ORDER BY declined_at DESC LIMIT 3"),
        "recent_transactions": q(
            """SELECT transaction_id, kind, merchant_name, merchant_category, amount, txn_at, status, entry_mode
               FROM agent_transactions WHERE customer_id = @cid ORDER BY txn_at DESC LIMIT 8"""),
        "sources": ["agent_customers", "agent_cards", "agent_transactions", "agent_disputes", "agent_fees", "agent_fraud_alerts", "agent_declines"],
    }


def merchant_activity(merchant: str, days: int = 30) -> dict:
    """How a merchant shows up across ALL customers: transactions, customers, fraud alerts, disputes.

    Use it to tell whether a charge the customer doesn't recognise is a one-off or a pattern.

    Args:
        merchant: Merchant name or part of it, e.g. "NOVAPLAY".
        days: Look-back window in days (1 to 365).

    Returns:
        Counts for the window, plus how many distinct customers raised a fraud alert or a dispute.
    """
    m = (merchant or "").strip()
    if not 2 <= len(m) <= 60:
        return {"status": "refused", "reason": "Give 2 to 60 characters of the merchant name."}
    days = max(1, min(int(days or 30), 365))
    like = f"%{m.upper()}%"
    tx = _query(
        f"""SELECT COUNT(*) AS transactions, COUNT(DISTINCT customer_id) AS customers, ROUND(SUM(amount), 2) AS total,
                   MIN(txn_at) AS first_seen, MAX(txn_at) AS last_seen
            FROM agent_transactions WHERE UPPER(merchant_name) LIKE @m AND txn_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)""",
        m=like,
    )[0]
    alerts = _query(
        f"""SELECT COUNT(*) AS alerts, COUNT(DISTINCT a.customer_id) AS customers, COUNTIF(a.status = 'open') AS open_alerts
            FROM agent_fraud_alerts a JOIN agent_transactions t USING (transaction_id)
            WHERE UPPER(t.merchant_name) LIKE @m AND a.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)""",
        m=like,
    )[0]
    disputes = _query(
        f"""SELECT COUNT(*) AS disputes, COUNT(DISTINCT customer_id) AS customers FROM agent_disputes
            WHERE UPPER(merchant) LIKE @m AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)""",
        m=like,
    )[0]
    return {"status": "ok", "merchant": m, "days": days, "transactions": tx, "fraud_alerts": alerts, "disputes": disputes,
            "sources": ["agent_transactions", "agent_fraud_alerts", "agent_disputes"]}


def policy_lookup(topic: str) -> dict:
    """Find the bank's rules and guidance on a topic: dispute rules, fee policies and knowledge articles.

    Args:
        topic: A few words, e.g. "dispute card not present", "late fee reversal", "lost card".

    Returns:
        Matching dispute rules, fee policies and up to 4 knowledge articles (title and text).
    """
    words = [w for w in re.split(r"[^a-z0-9]+", (topic or "").lower()) if len(w) >= 3][:6]
    if not words:
        return {"status": "refused", "reason": "Give a few words describing the topic."}
    joined = ",".join(words)
    hits = "(SELECT COUNTIF(STRPOS(LOWER({col}), w) > 0) FROM UNNEST(SPLIT(@w, ',')) AS w)"
    rule_hits = hits.format(col="CONCAT(reason, ' ', description)")
    fee_hits = hits.format(col="CONCAT(fee_type, ' ', description)")
    doc_hits = hits.format(col="CONCAT(title, ' ', content)")
    rules = _query(
        "SELECT rule_code, reason, description, max_days_since_txn, min_amount_minor / 100 AS min_amount, allowed_entry_modes, "
        f"requires_card_block, automatable FROM agent_dispute_rules WHERE active AND {rule_hits} > 0",
        w=joined,
    )
    fees = _query(f"SELECT rule_code, fee_type, reversible, description FROM agent_fee_policies WHERE {fee_hits} > 0", w=joined)
    docs = _query(
        f"""SELECT doc_id, source, title, SUBSTR(content, 1, 600) AS content, {doc_hits} AS score
            FROM agent_knowledge ORDER BY score DESC, source LIMIT 4""",
        w=joined,
    )
    return {"status": "ok", "dispute_rules": rules, "fee_policies": fees, "articles": [d for d in docs if d.get("score")],
            "sources": ["agent_dispute_rules", "agent_fee_policies", "agent_knowledge"]}
