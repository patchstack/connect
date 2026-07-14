// Shared demo-bundle runner used by BOTH gallery.mjs (live demonstration) and
// tests/protect/demo-rules.test.ts (regression). Given a demo bundle (rules carrying an
// `_demo` block), it drives one exploit + one benign probe per rule through the appropriate
// phase and reports whether each rule blocked/redacted the exploit and passed the benign.
//
// Keeping the dispatch here means the gallery and the test can never drift from each other.

const ORIGIN = 'https://demo.app';

function requestFrom(vec) {
  const url = ORIGIN + (vec.path ?? '/');
  const method = vec.method ?? 'GET';
  const init = { method };
  if (vec.body != null && method !== 'GET' && method !== 'HEAD') {
    init.headers = { 'content-type': 'application/json' };
    init.body = vec.body;
  }
  return new Request(url, init);
}

/**
 * @param {object} bundle  a demo rule bundle ({ firewall: [...] } with `_demo` on each rule)
 * @param {(opts:object)=>Promise<object>} createProtection
 * @returns {Promise<Array<{id,phase,category,title,desc,exploitCaught,benignOk,pass}>>}
 */
export async function runDemoBundle(bundle, createProtection) {
  // Stub the network BEFORE the egress guard wraps it, so "allowed" egress never hits the wire.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('stubbed-upstream', { status: 200 });

  const protection = await createProtection({ rules: bundle, mode: 'block', egress: true, allowHosts: [] });
  const guard = protection.fetchGuard();
  const results = [];

  const egressBlocked = async (url) => {
    try {
      await globalThis.fetch(url);
      return false;
    } catch {
      return true;
    }
  };
  const responseRedacted = async (body) => {
    const res = await protection.screenResponse(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const out = await res.text();
    return out !== body; // redact masks the offending span → body changes
  };

  try {
    for (const rule of bundle.firewall) {
      const d = rule._demo;
      if (!d) continue;
      const phase = rule.phase ?? 'request';
      let exploitCaught = false;
      let benignOk = false;

      if (phase === 'request') {
        exploitCaught = (await guard(requestFrom(d.exploit))) !== null;
        benignOk = (await guard(requestFrom(d.benign))) === null;
      } else if (phase === 'response') {
        exploitCaught = await responseRedacted(d.exploit.body);
        benignOk = !(await responseRedacted(d.benign.body));
      } else if (phase === 'egress') {
        exploitCaught = await egressBlocked(d.exploit.url);
        benignOk = !(await egressBlocked(d.benign.url));
      }

      results.push({
        id: rule.id,
        phase,
        category: rule.category,
        title: rule.title,
        desc: d.desc,
        exploitCaught,
        benignOk,
        pass: exploitCaught && benignOk,
      });
    }
  } finally {
    protection.uninstallEgress?.();
    globalThis.fetch = origFetch;
  }
  return results;
}
