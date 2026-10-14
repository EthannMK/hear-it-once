/**
 * KNOWLEDGE BASE (synthetic). A small curated set of demo guidance articles, each derived from
 * the prototype's explicit configured rules (DR-*, FP-*, verification and handoff procedures).
 * They are NOT real bank policy. Retrieval is deterministic keyword/category scoring behind a
 * replaceable adapter interface; when nothing relevant is found the caller is told so.
 */
import { all, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';

export interface KbArticle {
  id: string;
  title: string;
  categories: string[];
  keywords: string[];
  excerpt: string;
  steps: string[];
  ruleRefs: string[];
  version: string;
  synthetic: true;
}

export interface KbResult {
  article: KbArticle;
  score: number;
  reason: string;
}

export interface KnowledgeBaseAdapter {
  readonly name: string;
  search(q: { issueType: string | null; text: string; context: string[] }): Promise<KbResult[]>;
  get(id: string): KbArticle | null;
}

const V = 'demo-2026.10';
export const KB_ARTICLES: KbArticle[] = [
  {
    id: 'KB-101', title: 'Unrecognised card transaction', categories: ['unrecognised_transaction'], keywords: ['fraud', 'recognise', 'unauthorised', 'dispute', 'block'],
    excerpt: 'Verify identity, confirm the transaction from system records, then for an eligible card-not-present charge offer: block the card, order a replacement, and submit a fraud dispute (rule DR-FRAUD-01).',
    steps: ['Complete two-factor verification before discussing transactions.', 'Identify the transaction from verified records — never from the caller’s description alone.', 'Check card status, fraud alerts and prior cases.', 'If DR-FRAUD-01 is met: propose block → replacement → dispute, with explicit consent.', 'Chip-and-PIN or out-of-window charges: protect the card, then route to a specialist.'],
    ruleRefs: ['DR-FRAUD-01'], version: V, synthetic: true,
  },
  {
    id: 'KB-107', title: 'Declined card payments', categories: ['card_declined'], keywords: ['declined', 'decline', 'failing', 'travel', 'abroad', 'security rule', 'rejected'],
    excerpt: 'Report the decline reason exactly as the authorisation system returns it. The assistant makes no change to the card for a decline: a travel security rule, credit availability or a card status issue are explained, and anything that needs a change (such as a travel note) goes to an agent.',
    steps: ['Verify identity first.', 'Read the most recent declines and the card status.', 'Explain the recorded reason in plain words; never guess a reason.', 'State clearly that nothing was changed on the card.', 'Offer an agent for a travel note or any change.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-102', title: 'Lost or stolen card — block first', categories: ['lost_stolen_card'], keywords: ['lost', 'stolen', 'block', 'replacement', 'wallet'],
    excerpt: 'After identity verification, blocking the card is the first action. Do not collect non-essential details before the block is confirmed by the card system.',
    steps: ['Verify identity (no exceptions).', 'Confirm which card; propose the block immediately.', 'Only describe the card as blocked once the card system confirms it.', 'If the block fails or the outcome is unknown, escalate urgently.', 'Then offer a replacement and a review of recent transactions.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-103', title: 'Duplicate or incorrect charges', categories: ['wrong_or_duplicate_charge'], keywords: ['twice', 'duplicate', 'double', 'wrong amount', 'pending'],
    excerpt: 'A duplicate dispute (DR-DUP-01) needs two POSTED charges with the same merchant and amount within 24 hours and distinct authorisations. Pending authorisations often drop off — do not dispute them. Incorrect-amount disputes (DR-AMT-01) need a receipt and are agent-assisted.',
    steps: ['Compare both records: status, time apart, authorisation codes, merchant credits.', 'Explain the evidence to the customer.', 'Offer a dispute only when DR-DUP-01 is fully met.', 'Otherwise explain why and offer an agent review.'],
    ruleRefs: ['DR-DUP-01', 'DR-AMT-01'], version: V, synthetic: true,
  },
  {
    id: 'KB-104', title: 'Payment not showing', categories: ['payment_not_showing'], keywords: ['payment', 'paid', 'posting', 'pending', 'trace'],
    excerpt: 'Report exactly what the payment system returns: posted, pending, returned or failed. Only quote a posting date if the payment system supplies one — never estimate.',
    steps: ['Locate the payment by amount and date.', 'Explain the status and any status detail.', 'If no posting date is supplied, say so.', 'Returned/failed payments, or repeat contacts, go to the payments team.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-105', title: 'Late-payment fee courtesy reversal', categories: ['fee_query'], keywords: ['late', 'fee', 'waive', 'reverse', 'refund'],
    excerpt: 'Rule FP-LATE-01 (demo): one courtesy late-fee reversal per 12 months for accounts in good standing, up to the configured limit. Requires explicit customer confirmation and a confirmed ledger result.',
    steps: ['Confirm the fee from the fee system.', 'Check reversals in the last 12 months, account standing and the amount limit.', 'If eligible, offer the reversal and ask for confirmation.', 'If not, explain the rule and offer an agent for exception review.'],
    ruleRefs: ['FP-LATE-01'], version: V, synthetic: true,
  },
  {
    id: 'KB-106', title: 'Fees the assistant cannot reverse', categories: ['fee_query'], keywords: ['annual', 'foreign', 'cash advance', 'fee'],
    excerpt: 'Annual, foreign-transaction and cash-advance fees are not reversible by the assistant (FP-ANNUAL-01, FP-FX-01, FP-CASH-01). Explain and offer agent review.',
    steps: ['Identify the fee type.', 'Explain that it is outside the assistant’s authority.', 'Offer an agent for review.'],
    ruleRefs: ['FP-ANNUAL-01', 'FP-FX-01', 'FP-CASH-01'], version: V, synthetic: true,
  },
  {
    id: 'KB-111', title: 'Identity verification and failed verification', categories: ['verification'], keywords: ['verify', 'identity', 'passcode', 'date of birth', 'card number', 'locked'],
    excerpt: 'Demo verification compares a knowledge factor on the server: the card number (Northstar demo) or date of birth plus a one-time passcode. Caller ID, a claimed name or voice are never proof. A wrong answer keeps the call going with the attempt count; after three failures, stop and hand off without disclosing anything.',
    steps: ['Identify, then verify the factor on the server.', 'Never reveal the expected value.', 'Allow retries until three failures, then a warm handoff with no account data and no actions.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-110', title: 'Account and card information requests', categories: ['account_inquiry'], keywords: ['status', 'recent transactions', 'active', 'activity', 'balance'],
    excerpt: 'After verification the assistant may read back card status and recent purchases exactly as the card and transaction systems return them. It does not estimate balances or limits, and makes no change.',
    steps: ['Verify identity first.', 'Read card status and recent purchases from the systems.', 'Report only what is recorded; say plainly what is not available.', 'Offer an agent for anything that needs a change.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-108', title: 'Warm handoff and agent brief', categories: ['handoff'], keywords: ['agent', 'person', 'human', 'transfer', 'escalate'],
    excerpt: 'Transfer without resistance when asked. The brief must carry the customer’s words, verification status, verified facts, actions and their real outcomes, risk flags and a recommended next step so the customer never repeats themselves.',
    steps: ['Stop any unsafe or pending action.', 'Build the brief from recorded state.', 'Tell the customer what happens next; never claim a transfer before an agent accepts.'],
    ruleRefs: [], version: V, synthetic: true,
  },
  {
    id: 'KB-109', title: 'Third-party callers and takeover signals', categories: ['security'], keywords: ['on behalf', 'mother', 'husband', 'changed', 'takeover'],
    excerpt: 'Only the cardholder can be helped by the assistant. Third-party callers, recent contact-detail changes or account-takeover alerts route to a specialist with no automated actions.',
    steps: ['Do not act for a third party.', 'Treat recent contact changes as a risk signal.', 'Hand off with the risk flag recorded.'],
    ruleRefs: [], version: V, synthetic: true,
  },
];

export const mockKnowledgeBase: KnowledgeBaseAdapter = {
  name: 'mock-kb (synthetic demo guidance)',
  async search({ issueType, text, context }) {
    const t = `${text} ${context.join(' ')}`.toLowerCase();
    const scored = KB_ARTICLES.map((a) => {
      let score = 0;
      const why: string[] = [];
      if (issueType && a.categories.includes(issueType)) {
        score += 3;
        why.push('matches the call’s issue type');
      }
      for (const c of context) if (a.categories.includes(c)) {
        score += 2;
        why.push(`matches “${c.replace(/_/g, ' ')}”`);
      }
      const hits = a.keywords.filter((k) => t.includes(k));
      if (hits.length) {
        score += hits.length * 0.5;
        why.push(`mentions ${hits.slice(0, 3).join(', ')}`);
      }
      return { article: a, score, reason: why.join('; ') };
    });
    return scored.filter((s) => s.score >= 2).sort((a, b) => b.score - a.score).slice(0, 2);
  },
  get: (id) => KB_ARTICLES.find((a) => a.id === id) ?? null,
};

let kb: KnowledgeBaseAdapter = mockKnowledgeBase;
export const knowledgeBase = () => kb;
export function setKnowledgeBaseForTests(k: KnowledgeBaseAdapter | null): void {
  kb = k ?? mockKnowledgeBase;
}

export function recordKbReference(sessionId: string, r: KbResult, query: string, opts: { supportsNextStep: boolean; agentReview: boolean }): void {
  run(
    `INSERT INTO kb_references (session_id, article_id, query, score, reason, supports_next_step, agent_review, created_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id, article_id) DO UPDATE SET supports_next_step = MAX(supports_next_step, excluded.supports_next_step), agent_review = MAX(agent_review, excluded.agent_review)`,
    [sessionId, r.article.id, query.slice(0, 200), r.score, r.reason, opts.supportsNextStep ? 1 : 0, opts.agentReview ? 1 : 0, nowIso()],
  );
}

export function kbReferencesFor(sessionId: string) {
  return all<{ article_id: string; query: string; score: number; reason: string; supports_next_step: number; agent_review: number; created_at: string }>(
    'SELECT * FROM kb_references WHERE session_id = ? ORDER BY score DESC, id',
    [sessionId],
  ).map((r) => {
    const a = KB_ARTICLES.find((x) => x.id === r.article_id);
    return {
      id: r.article_id,
      title: a?.title ?? r.article_id,
      excerpt: a?.excerpt ?? '',
      steps: a?.steps ?? [],
      ruleRefs: a?.ruleRefs ?? [],
      version: a?.version ?? '',
      query: r.query,
      reason: r.reason,
      supportsNextStep: !!r.supports_next_step,
      agentReview: !!r.agent_review,
      synthetic: true,
    };
  });
}
