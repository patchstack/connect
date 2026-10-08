export const ACTIVATION_HEADER: string;
export function activationChallenge(secret: string, url: string, now?: number): Promise<string>;
export function activationResponse(request: Pick<Request, 'url' | 'method' | 'headers'>, secret: string | null, status: () => Record<string, unknown>, now?: number): Promise<Response | null>;
export function verifyActivationResponse(secret: string, challenge: string, body: string, signature: string | null): Promise<Record<string, unknown> | null>;
