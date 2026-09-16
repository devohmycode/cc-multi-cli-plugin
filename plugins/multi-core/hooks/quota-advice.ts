import type { UsagePaneProps } from './usage-view.ts';

/** Only account summaries enter model context; receipts and worker data stay in the menu. */
export function quotaAdvice(snapshot?: UsagePaneProps): string {
  const instructions = [
    '[Multi quota-aware model selection — advisory]',
    'Before choosing a subagent model, prefer the lowest subscription usage among the enabled providers whose models suit the task.',
    'Respect explicit user model choices. You may choose a more-used model when its capabilities better fit the task; this hook does not restrict your choice.',
    'Use current usage, without waiting for a quota reset. Prefer included subscription capacity over paid overages.',
    'Percentages describe separate provider allowances, not equal token budgets. Unknown quota is not unused quota.',
  ];
  if (!snapshot) {
    return [
      ...instructions,
      'Current quota could not be retrieved. Choose based on task requirements.',
    ].join('\n');
  }
  const rows = snapshot.providers.filter((provider) => provider.status !== 'disabled');
  return [
    ...instructions,
    `Account usage checked ${snapshot.updatedAt}:`,
    ...rows.map(
      (provider) =>
        `${provider.name}: ${provider.status === 'ready' ? provider.summary : 'quota unknown or unavailable'}`,
    ),
  ].join('\n');
}
