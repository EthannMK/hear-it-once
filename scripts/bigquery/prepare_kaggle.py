"""
Turn the Kaggle "Credit Card Transactions Fraud Detection Dataset" (kartik2112/fraud-detection,
generated with the Sparkov simulator, listed as CC0) into transaction history for the synthetic
Northstar customers.

Usage: python3 prepare_kaggle.py <fraudTrain.csv> <export-dir>

- One Kaggle card (cc_num) becomes one Northstar customer's history, chosen deterministically.
- Card numbers, names, street addresses, dates of birth and trans_num are NOT carried over.
- Dates are moved onto the demo clock. Demo customers get history 125-365 days back, outside the
  120-day window the call workflows look at, so the scripted demo stories are unchanged. Background
  customers get history across the last year.
- Kaggle's is_fraud label is kept as a column, and each labelled transaction gets a CLOSED
  historical fraud alert (never an open one, so no live call is affected).

Writes transactions_kaggle.json and fraud_alerts_kaggle.json into <export-dir>.
"""
import csv
import hashlib
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

PER_CUSTOMER = 250


# Sparkov's categories mapped to the merchant category codes a card network would carry.
MCC = {
    "grocery_pos": "5411", "grocery_net": "5411", "gas_transport": "5541", "home": "5200",
    "shopping_pos": "5999", "shopping_net": "5999", "food_dining": "5812", "entertainment": "7832",
    "personal_care": "7230", "health_fitness": "8099", "misc_pos": "5999", "misc_net": "5999",
    "kids_pets": "5995", "travel": "4722",
}
ACQUIRERS = ["First Data", "Worldpay", "Chase Paymentech", "Elavon", "Global Payments"]

def main(src: str, out: str) -> None:
    customers = [json.loads(l) for l in open(f"{out}/customers.json") if l.strip()]
    cards = {c["customer_id"]: c["card_id"] for c in (json.loads(l) for l in open(f"{out}/cards.json") if l.strip()) if c["holder_role"] == "primary"}
    anchor = datetime.fromisoformat(json.loads(open(f"{out}/dataset_meta.json").readline())["anchor_at"].replace("Z", "+00:00"))
    ids = sorted(c["customer_id"] for c in customers)

    counts = Counter()
    with open(src, newline="") as f:
        for r in csv.DictReader(f):
            counts[r["cc_num"]] += 1
    chosen = [cc for cc, n in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[: len(ids)]]
    owner = {cc: ids[i] for i, cc in enumerate(chosen)}

    rows = defaultdict(list)
    with open(src, newline="") as f:
        for r in csv.DictReader(f):
            cust = owner.get(r["cc_num"])
            if cust:
                rows[cust].append(r)

    txns, alerts = [], []
    for cust, rs in rows.items():
        rs.sort(key=lambda r: int(r["unix_time"]))
        rs = rs[-PER_CUSTOMER:]
        t0, t1 = int(rs[0]["unix_time"]), int(rs[-1]["unix_time"])
        demo = not cust.startswith("CUS-BG")
        newest, oldest = (125, 365) if demo else (1, 365)
        for r in rs:
            frac = (int(r["unix_time"]) - t0) / max(1, t1 - t0)
            at = anchor - timedelta(days=oldest - frac * (oldest - newest))
            tid = "KG-" + hashlib.sha1(r["trans_num"].encode()).hexdigest()[:14].upper()
            cat = r["category"]
            merchant = r["merchant"].removeprefix("fraud_").replace(",", "").strip()
            fraud = r["is_fraud"] == "1"
            txns.append({
                "transaction_id": tid, "customer_id": cust, "card_id": cards.get(cust), "kind": "purchase",
                "merchant_name": merchant, "merchant_category": cat, "amount_minor": round(float(r["amt"]) * 100), "currency": "USD",
                "txn_at": at.isoformat().replace("+00:00", "Z"), "posted_at": (at + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
                "status": "posted", "entry_mode": "ecommerce" if cat.endswith("_net") else "contactless" if cat == "gas_transport" else "chip",
                "auth_code": "K" + hashlib.sha1(tid.encode()).hexdigest()[:5].upper(), "related_payment_id": None,
                "source": "kaggle_sparkov", "is_fraud_label": fraud,
                # Card-system detail, so history rows read like the rest of the ledger. The Sparkov
                # data is US and carries no merchant city, so the city is left empty rather than
                # filled with the cardholder's own town.
                "mcc": MCC.get(cat, "5999"), "merchant_city": None, "merchant_country": "US",
                "network_ref": "7" + str(int(hashlib.sha1(tid.encode()).hexdigest()[:16], 16))[:22].rjust(22, "0"),
                "acquirer": ACQUIRERS[int(hashlib.sha1(tid.encode()).hexdigest()[:8], 16) % len(ACQUIRERS)],
            })
            if fraud:
                alerts.append({
                    "alert_id": "FRA-" + tid, "customer_id": cust, "card_id": cards.get(cust), "transaction_id": tid,
                    "alert_type": "historic_fraud_label", "risk_level": "high", "status": "closed", "reported_card_status": "active",
                    "reported_amount_minor": round(float(r["amt"]) * 100), "created_at": at.isoformat().replace("+00:00", "Z"),
                })

    with open(f"{out}/transactions_kaggle.json", "w") as f:
        f.writelines(json.dumps(t) + "\n" for t in txns)
    with open(f"{out}/fraud_alerts_kaggle.json", "w") as f:
        f.writelines(json.dumps(a) + "\n" for a in alerts)
    print(f"kaggle: {len(txns)} transactions for {len(rows)} customers, {len(alerts)} historical fraud labels")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
