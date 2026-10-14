// A read-only, domain-separated challenge. Never send the credential to a preview origin.
export const ACTIVATION_HEADER = 'x-patchstack-activation';
const encoder = new TextEncoder();
async function sign(secret, value) {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2,'0')).join('');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
function pathOf(url) { return new URL(url, 'https://activation.invalid').pathname; }

export async function activationChallenge(secret, url, now = Date.now()) {
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2,'0')).join('');
  const challenge = `${now}.${nonce}`;
  return `${challenge}.${await sign(secret, `patchstack-activation-request-v1\nOPTIONS\n${pathOf(url)}\n${challenge}`)}`;
}

/** No secret, invalid challenge, or disabled Web Crypto: ordinary application routing is untouched. */
export async function activationResponse(request, secret, status, now = Date.now()) {
  const header = request.headers?.get?.(ACTIVATION_HEADER);
  if (!secret || request.method !== 'OPTIONS' || typeof header !== 'string' || !/^\d{13}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(header)) return null;
  const [timestamp, nonce, signature] = header.split('.');
  if (Math.abs(now - Number(timestamp)) > 60_000) return null;
  try {
    const expected = await sign(secret, `patchstack-activation-request-v1\nOPTIONS\n${pathOf(request.url)}\n${timestamp}.${nonce}`);
    if (!equal(signature, expected)) return null;
    const body = JSON.stringify({version:1, challenge:`${timestamp}.${nonce}`, ...status()});
    return new Response(body, {headers:{
      'content-type':'application/json', 'cache-control':'no-store',
      [ACTIVATION_HEADER]: await sign(secret, `patchstack-activation-response-v1\n${body}`),
    }});
  } catch { return null; }
}

export async function verifyActivationResponse(secret, challenge, body, signature) {
  if (typeof body !== 'string' || body.length > 16_384) return null;
  try {
    if (!equal(signature, await sign(secret, `patchstack-activation-response-v1\n${body}`))) return null;
    const result = JSON.parse(body);
    return result.version === 1 && result.challenge === challenge.split('.').slice(0,2).join('.') ? result : null;
  } catch { return null; }
}
