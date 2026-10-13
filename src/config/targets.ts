/**
 * BRD PROPOSED PILOT TARGETS. These are targets to measure against, never claims of
 * achieved performance. The dashboard renders them separately from observed values.
 */
export interface Target {
  id: string;
  label: string;
  /** Human-readable target statement from the BRD. */
  statement: string;
  comparator: '>=' | '<=' | '<' | 'info';
  value: number | null;
  unit: '%' | 's' | 'calls' | 'points' | 'ratio' | 'count';
  /** Can the target be meaningfully evaluated from local demo data? */
  locallyTestable: boolean;
  note: string;
}

export const PILOT_TARGETS: Target[] = [
  { id: 'answer_time', label: 'Answer time', statement: 'Answer within 30 seconds, no menu or queue', comparator: '<=', value: 30, unit: 's', locallyTestable: true, note: 'Simulator answers immediately; real telephony required for a meaningful measure.' },
  { id: 'aht_reduction', label: 'Handling time reduction', statement: 'At least 40% lower handling time on eligible calls', comparator: '>=', value: 40, unit: '%', locallyTestable: false, note: 'Requires a real four-week baseline. Demo shows absolute AHT only.' },
  { id: 'wait_time', label: 'Wait / hold time', statement: 'Customer waiting or hold time of 1 minute or less', comparator: '<=', value: 60, unit: 's', locallyTestable: true, note: 'Computed from recorded hold intervals.' },
  { id: 'fcr', label: 'First-call resolution', statement: 'At least 60% of eligible calls', comparator: '>=', value: 60, unit: '%', locallyTestable: true, note: 'Resolution uses the documented resolution status, not case creation.' },
  { id: 'repeat_7d', label: 'Repeat contacts (7 days)', statement: 'At least 20% fewer repeat calls within 7 days', comparator: '>=', value: 20, unit: '%', locallyTestable: false, note: 'Needs baseline. Demo shows the observed repeat-contact rate only.' },
  { id: 'repetition', label: 'Customer repetition', statement: 'Customer asked to repeat issue in fewer than 5% of calls', comparator: '<', value: 5, unit: '%', locallyTestable: true, note: 'From restatement events and QA/agent flags.' },
  { id: 'block_rate', label: 'Cards blocked within 60 s', statement: '≥95% of confirmed lost/stolen/fraud cards blocked within 60 s of verification', comparator: '>=', value: 95, unit: '%', locallyTestable: true, note: 'Only confirmed (succeeded) blocks count as success; failed/unknown count against.' },
  { id: 'dispute_no_rework', label: 'Disputes without rework', statement: '≥90% of submitted disputes accepted without rework', comparator: '>=', value: 90, unit: '%', locallyTestable: false, note: 'Demo uses SIMULATED downstream status; real definition needs the dispute team.' },
  { id: 'csat', label: 'Satisfaction', statement: 'Not below baseline; target +10 points', comparator: 'info', value: 10, unit: 'points', locallyTestable: false, note: 'Demo survey scores are simulated.' },
  { id: 'agent_calls', label: 'Calls per agent per shift', statement: '50 proposed target (~78 illustrative ceiling, not a guarantee)', comparator: '>=', value: 50, unit: 'calls', locallyTestable: false, note: 'Do not claim from local demo metrics.' },
  { id: 'case_before_end', label: 'Case before call end', statement: '≥95% of resolved-call cases created before call ends', comparator: '>=', value: 95, unit: '%', locallyTestable: true, note: 'Case created timestamp vs session ended timestamp.' },
  { id: 'action_correctness', label: 'Action correctness (QA)', statement: '≥95% in QA sample; zero wrong card actions', comparator: '>=', value: 95, unit: '%', locallyTestable: true, note: 'Safety incidents tracked separately from QA score.' },
  { id: 'availability', label: 'Assistant availability', statement: '≥99.5% proposed', comparator: '>=', value: 99.5, unit: '%', locallyTestable: false, note: 'Requires deployed monitoring and a defined window.' },
  { id: 'stage_retrieval', label: 'Parallel fact retrieval', statement: '≤2 min on ≥90% of eligible calls', comparator: '<=', value: 120, unit: 's', locallyTestable: true, note: 'p90 of retrieval stage duration.' },
  { id: 'stage_proposal', label: 'Action proposal', statement: '≤2 min on ≥90% of eligible calls', comparator: '<=', value: 120, unit: 's', locallyTestable: true, note: 'p90 from retrieval complete to proposal.' },
  { id: 'stage_execution', label: 'Execution + case', statement: '≤2 min 30 s on ≥90% of eligible calls', comparator: '<=', value: 150, unit: 's', locallyTestable: true, note: 'p90 from consent to last action outcome.' },
  { id: 'handoff_join', label: 'Agent joins after request', statement: 'Within 30 s, subject to real telephony', comparator: '<=', value: 30, unit: 's', locallyTestable: false, note: 'Simulated agents join when a demo agent accepts.' },
];
