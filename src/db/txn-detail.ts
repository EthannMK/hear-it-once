/**
 * The detail a card agent expects on a transaction, derived once per entry.
 *
 * Card platforms publish broadly the same record for an authorisation: when it happened and when it
 * settled, what the merchant is and where, how the card was presented, and the references used to
 * trace or dispute it (authorisation code, acquirer reference number, acquirer). This file produces
 * those fields for the simulated bank so the agent screen reads like a card system rather than a
 * sketch of one.
 *
 * Everything here is derived from the transaction id, so a given transaction always carries the same
 * references no matter how often it is read, and nothing changes under the agent mid-call.
 */

/** Merchant category codes, as a card network assigns them, with the label an agent reads. */
const MCC_BY_CATEGORY: Record<string, [string, string]> = {
  grocery: ['5411', 'Grocery stores, supermarkets'],
  groceries: ['5411', 'Grocery stores, supermarkets'],
  dining: ['5812', 'Eating places, restaurants'],
  restaurant: ['5812', 'Eating places, restaurants'],
  coffee: ['5814', 'Fast food restaurants'],
  transport: ['4121', 'Taxicabs and limousines'],
  travel: ['4722', 'Travel agencies and tour operators'],
  fuel: ['5541', 'Service stations'],
  digital: ['5815', 'Digital goods: media, books, movies'],
  digital_goods: ['5815', 'Digital goods: media, books, movies'],
  entertainment: ['7832', 'Motion picture theatres'],
  utilities: ['4900', 'Utilities: electric, gas, water'],
  retail: ['5999', 'Miscellaneous retail'],
  health: ['8099', 'Health practitioners and medical services'],
  pharmacy: ['5912', 'Drug stores and pharmacies'],
  electronics: ['5732', 'Electronics stores'],
  telecom: ['4814', 'Telecommunication services'],
  insurance: ['6300', 'Insurance sales and underwriting'],
  subscription: ['5968', 'Direct marketing: continuity subscription'],
};
const DEFAULT_MCC: [string, string] = ['5999', 'Miscellaneous retail'];

/** Where the demo bank's customers shop. Chosen per transaction, never random at read time. */
const PLACES: [string, string][] = [
  ['Singapore', 'SG'], ['Singapore', 'SG'], ['Bangkok', 'TH'], ['Yangon', 'MM'],
  ['Kuala Lumpur', 'MY'], ['Manila', 'PH'], ['Hong Kong', 'HK'], ['Jakarta', 'ID'],
];
const ACQUIRERS = ['DBS Bank', 'UOB Merchant Services', 'Adyen', 'Stripe Payments', 'Worldpay', 'First Data'];
const ONLINE = new Set(['ecommerce', 'recurring']);

/** A stable number from a string: the same id always gives the same digits. */
function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/**
 * n digits from a seed. The shift is unsigned and the value taken positive: a negative seed would
 * print a minus sign, and a reference like "7795-2644" reads as a card number to anything scanning
 * for one.
 */
const digits = (seed: number, n: number) => String(Math.abs(seed >>> 0) % 10 ** n).padStart(n, '0');

export interface TxnDetail {
  mcc: string;
  mccLabel: string;
  merchantCity: string | null;
  merchantCountry: string | null;
  acquirer: string | null;
  /** Acquirer reference number: what a dispute is filed against. */
  networkRef: string | null;
}

/**
 * Derive the detail for one transaction. A payment or a fee has no merchant, no terminal and no
 * acquirer, so those stay empty rather than being filled with a plausible-looking value.
 */
export function txnDetail(input: { id: string; kind: string; category?: string | null; entryMode?: string | null; merchant?: string | null }): TxnDetail {
  const seed = hash(input.id);
  const bank = !input.merchant || input.kind === 'payment' || input.kind === 'fee';
  const [mcc, mccLabel] = bank ? ['6012', 'Financial institutions: merchandise and services'] : (MCC_BY_CATEGORY[String(input.category ?? '').toLowerCase()] ?? DEFAULT_MCC);
  if (bank) return { mcc, mccLabel, merchantCity: null, merchantCountry: null, acquirer: null, networkRef: null };
  const online = ONLINE.has(String(input.entryMode ?? ''));
  const [city, country] = PLACES[seed % PLACES.length];
  return {
    mcc,
    mccLabel,
    // An online purchase has no shop to stand in: the card network carries the merchant's own country.
    merchantCity: online ? null : city,
    merchantCountry: country,
    acquirer: ACQUIRERS[(seed >>> 5) % ACQUIRERS.length],
    // ARN format: 23 digits, acquirer BIN first. Traceable, and the shape a dispute team expects.
    networkRef: `7${digits(seed, 8)}${digits(seed >>> 3, 9)}${digits(seed >>> 7, 5)}`,
  };
}

/** A six-digit approval code, as a card network returns on an approved authorisation. */
export const authCodeFor = (id: string) => digits(hash(`auth:${id}`), 6);
