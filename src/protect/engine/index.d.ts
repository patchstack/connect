// Client
export interface RuleClientOptions {
  token?: string;
  baseUrl?: string;
  cacheTtl?: number;
}

export interface RuleCondition {
  parameter: string;
  match: { type: string; value: any };
  inclusive?: boolean;
  mutations?: string[];
  rules?: RuleCondition[];
}

export interface FirewallRule {
  id: number;
  title: string;
  rule_v2: RuleCondition[];
  message?: string;
}

export interface Whitelist {
  rule_id?: number;
  rule_v2: RuleCondition[];
}

export interface RulesResult {
  success: boolean;
  error?: string;
  firewall: FirewallRule[];
  whitelists: Whitelist[];
  whitelist_keys: Record<string, string[]>;
}

export declare class PatchstackRuleClient {
  constructor(options?: RuleClientOptions);
  getRules(): Promise<RulesResult>;
  clearCache(): void;
}

// Engine
export interface EvaluateResult {
  blocked: boolean;
  rule: FirewallRule | null;
  message: string | null;
}

export declare class RuleEngine {
  constructor(rulesData?: { firewall?: FirewallRule[]; whitelists?: Whitelist[]; whitelist_keys?: Record<string, string[]> });
  evaluate(req: any): EvaluateResult;
}

// Request
export declare class RequestResolver {
  constructor(req: any);
  resolve(parameter: string): any[];
  applyMutations(mutations: string[], value: any): any;
}

// Middleware
export interface ProtectOptions {
  token?: string;
  baseUrl?: string;
  cacheTtl?: number;
  logging?: boolean;
  onBlock?: (event: any) => void;
  onScan?: (rulesData: RulesResult) => void;
  onError?: (error: Error) => void;
}

export interface WafStats {
  total: number;
  blocked: number;
  allowed: number;
  avgDuration: number;
}

export interface WafEvent {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  duration: number;
  blocked: boolean;
}

export interface WafLogger {
  middleware: (req: any, res: any, next: any) => void;
  getStats: () => WafStats;
  getEvents: () => WafEvent[];
}

export interface ProtectMiddleware {
  (req: any, res: any, next: any): void;
  getStats?: () => WafStats;
  getEvents?: () => WafEvent[];
  rules?: RulesResult;
  engine?: RuleEngine;
}

export declare function createMiddleware(rulesData: { firewall?: FirewallRule[]; whitelists?: Whitelist[] }, options?: { onBlock?: (event: any) => void }): (req: any, res: any, next: any) => void;
export declare function createLogger(): WafLogger;
export declare function protect(options?: ProtectOptions): Promise<ProtectMiddleware>;
export declare function protectSync(options?: ProtectOptions): (req: any, res: any, next: any) => void;

// Normalizer
export interface NormalizeOptions {
  urlDecode?: boolean;
  htmlDecode?: boolean;
  sqlComments?: boolean;
  nullBytes?: boolean;
  whitespace?: boolean;
}

export declare function normalize(value: string, options?: NormalizeOptions): string;
export declare function normalizeRequest(req: any, options?: NormalizeOptions): {
  query: Record<string, any>;
  body: Record<string, any>;
  headers: Record<string, string>;
  url: string;
  originalUrl: string;
  _rawBody: string;
};
export declare function urlDecode(value: string): string;
export declare function htmlEntityDecode(value: string): string;
export declare function removeSqlComments(value: string): string;
