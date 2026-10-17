-- Transaction detail a card agent expects to see, matching what card platforms publish in their
-- authorisation and activity records: where the merchant is, how the card was presented, and the
-- references used to trace or dispute the entry.
ALTER TABLE bank_transactions ADD COLUMN mcc TEXT;              -- 4-digit merchant category code
ALTER TABLE bank_transactions ADD COLUMN merchant_city TEXT;
ALTER TABLE bank_transactions ADD COLUMN merchant_country TEXT; -- ISO 3166-1 alpha-2
ALTER TABLE bank_transactions ADD COLUMN network_ref TEXT;      -- acquirer reference number (ARN)
ALTER TABLE bank_transactions ADD COLUMN acquirer TEXT;
ALTER TABLE bank_transactions ADD COLUMN billing_amount_minor INTEGER; -- amount billed when it differs
ALTER TABLE bank_transactions ADD COLUMN fx_rate TEXT;
