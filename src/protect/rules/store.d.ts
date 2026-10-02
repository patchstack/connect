export interface RuleStore {
  read(): Promise<Record<string, unknown> | null>;
  write(envelope: Record<string, unknown>): Promise<void>;
}
export function makeStore(options?: Record<string, unknown>): RuleStore;
