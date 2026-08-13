// Which origins this guard is willing to talk to. Both of its remote conversations are security
// sensitive: the RULE endpoint delivers policy the engine then executes on every request (an
// attacker-controlled endpoint could remove protection wholesale or serve a CPU-expensive ruleset), and
// the telemetry endpoint receives the site api_key. Env/CI injection is the realistic threat, so a
// non-default override must be https — with localhost permitted so local development and tests work.
export function isSafeOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
  } catch {
    return false;
  }
}

/**
 * Accept `candidate` only if it is a safe origin; otherwise warn once and fall back to `fallback`.
 * @param {string|undefined} candidate @param {string} fallback @param {string} label
 */
export function safeBaseUrl(candidate, fallback, label) {
  if (typeof candidate !== 'string' || candidate === '') return fallback;
  if (isSafeOrigin(candidate)) return candidate;
  warnOnce(label, `[patchstack] ignoring unsafe ${label} override (${candidate}): must be https (or localhost). Using the default.`);
  return fallback;
}

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
}
