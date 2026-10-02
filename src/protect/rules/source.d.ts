import type { RuleStore } from './store.js';

export function resolveRules(
  options: Record<string, unknown>,
  store: RuleStore,
  context?: { timeoutMs?: number; pulseAuth?: string | null },
): Promise<{
  firewall: Array<Record<string, unknown>>;
  source: { ok: boolean; origin: 'api' | 'cache' | 'bundled' | 'empty'; reason?: string };
}>;
