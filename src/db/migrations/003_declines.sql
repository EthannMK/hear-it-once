-- SYNTHETIC mock bank "authorisations" system: declined card payments and the reason the
-- (simulated) issuer gave. Read-only for the assistant; used by the card-declined demo journey.
CREATE TABLE bank_declines (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES bank_customers(id),
  card_id       TEXT REFERENCES bank_cards(id),
  merchant_name TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  declined_at   TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('travel_security_rule','insufficient_available_credit','card_blocked','card_expired','merchant_category_restricted')),
  customer_action TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_bank_declines_customer ON bank_declines(customer_id, declined_at);
