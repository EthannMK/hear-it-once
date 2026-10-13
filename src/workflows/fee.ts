/** Workflow: FEE QUERY (BRD §6.3). Reversal only when eligible, within limits, and confirmed. */
import type { FeeRecord } from '../adapters/types.ts';
import { sourceData } from '../retrieval/retrieval.ts';
import { feeReversalEligibility } from '../policy/eligibility.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { offerAgent, opByType, sourceGuard } from './common.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

const FEE_LABEL: Record<string, string> = { late_payment: 'late payment fee', annual_fee: 'annual fee', foreign_transaction: 'foreign transaction fee', cash_advance: 'cash advance fee' };

function evaluateFee(ctx: WorkflowCtx, fee: FeeRecord): WorkflowResult {
  const data = sourceData(ctx.snap, 'fee_policy')!;
  ctx.wf.selectedFeeId = fee.feeId;
  const elig = feeReversalEligibility({ fee, data });
  const label = FEE_LABEL[fee.feeType] ?? fee.feeType;
  const findings: Finding[] = [
    { kind: 'confirmed', text: `A ${label} of ${formatMoney(fee.amountMinor, fee.currency)} was charged on ${formatDate(fee.chargedAt)}.`, source: 'fee_policy' },
    { kind: 'confirmed', text: `Courtesy reversals in the last 12 months: ${data.reversalsLast12Months}. Account standing: ${data.accountStanding}.`, source: 'fee_policy' },
  ];
  const pays = sourceData(ctx.snap, 'payment_status');
  if (fee.feeType === 'late_payment' && pays) {
    const nearby = pays.filter((p) => Math.abs(Date.parse(p.initiatedAt) - Date.parse(fee.chargedAt)) < 10 * 86_400_000);
    if (nearby.length) findings.push({ kind: 'confirmed', text: `Payment around that time: ${formatMoney(nearby[0].amountMinor)} initiated ${formatDate(nearby[0].initiatedAt)}, status ${nearby[0].status}.`, source: 'payment_status' });
  }
  if (elig.eligible) {
    findings.push({ kind: 'confirmed', text: `Eligible for a one-off courtesy reversal under rule ${elig.ruleCode} (${elig.ruleVersion}).`, source: 'fee_policy' });
    return {
      kind: 'propose',
      message: `I can see a ${label} of ${formatMoney(fee.amountMinor)} charged on ${formatDate(fee.chargedAt)}. Your account qualifies for a one-off courtesy reversal under our policy ${elig.ruleCode} — it can be used once in any 12 months. Would you like me to reverse this ${formatMoney(fee.amountMinor)} fee?`,
      actions: [{ type: 'reverse_fee', targetRef: fee.feeId, params: { ruleCode: elig.ruleCode! }, label: `Reverse the ${formatMoney(fee.amountMinor)} ${label}` }],
      findings,
      ruleRefs: [elig.ruleCode!],
      transactionRefs: fee.transactionId ? [fee.transactionId] : [],
      eligibility: elig,
    };
  }
  findings.push({ kind: 'confirmed', text: `Not eligible for reversal under rule ${elig.ruleCode ?? 'n/a'}: ${elig.reasons.join(' ')}`, source: 'fee_policy' });
  return {
    kind: 'inform',
    message: `I can see a ${label} of ${formatMoney(fee.amountMinor)} charged on ${formatDate(fee.chargedAt)}. I'm not able to reverse it: ${elig.reasons.join(' ')}${elig.ruleCode ? ` (policy ${elig.ruleCode})` : ''}`,
    findings,
    resolution: 'unresolved',
    nextSteps: 'Fee reversal not eligible under policy; agent offered for exception review.',
    transactionRefs: fee.transactionId ? [fee.transactionId] : [],
    eligibility: elig,
    offerAgent: offerAgent('out_of_policy', 'An agent can review whether an exception is possible. Would you like me to transfer you?'),
  };
}

export const feeWorkflow: Workflow = {
  start(ctx) {
    const guard = sourceGuard(ctx.snap, 'fee_query');
    if (guard) return guard;
    const data = sourceData(ctx.snap, 'fee_policy')!;
    let fees = data.fees.filter((f) => !f.reversedAt);
    if (ctx.slots.feeType) {
      const typed = fees.filter((f) => f.feeType === ctx.slots.feeType);
      if (typed.length) fees = typed;
    }
    if (ctx.wf.selectedFeeId) {
      const f = data.fees.find((x) => x.feeId === ctx.wf.selectedFeeId);
      if (f) return evaluateFee(ctx, f);
    }
    if (!fees.length) {
      return {
        kind: 'inform',
        message: "I can't see any fees on your account that haven't already been reversed.",
        findings: [{ kind: 'confirmed', text: 'No unreversed fees on the account.', source: 'fee_policy' }],
        resolution: 'informational',
        nextSteps: 'No fees found.',
      };
    }
    const types = new Set(fees.map((f) => f.feeType));
    if (types.size > 1) {
      ctx.wf.step = 'choose_fee';
      return { kind: 'clarify', purpose: 'choose_fee', message: 'Which fee are you asking about?', choices: fees.slice(0, 4).map((f) => ({ id: f.feeId, label: `${FEE_LABEL[f.feeType] ?? f.feeType} · ${formatMoney(f.amountMinor)} · ${formatDate(f.chargedAt)}` })) };
    }
    return evaluateFee(ctx, fees[0]);
  },
  onChoice(ctx, _purpose, id) {
    const f = sourceData(ctx.snap, 'fee_policy')?.fees.find((x) => x.feeId === id);
    return f ? evaluateFee(ctx, f) : this.start(ctx);
  },
  onYesNo(ctx) {
    return this.start(ctx);
  },
  afterActions(_ctx, ops) {
    const r = opByType(ops, 'reverse_fee');
    return {
      kind: 'inform',
      message: r?.status === 'succeeded' ? 'The credit will show on your account as a fee reversal.' : '',
      findings: [],
      resolution: r?.status === 'succeeded' ? 'resolved' : 'partially_resolved',
      nextSteps: r?.status === 'succeeded' ? 'Fee reversed (confirmed by fee ledger).' : 'Fee reversal not confirmed — follow up.',
    };
  },
  onDeclined() {
    return { kind: 'inform', message: 'Okay, I’ve left the fee as it is.', findings: [], resolution: 'informational', nextSteps: 'Customer declined fee reversal.' };
  },
};
