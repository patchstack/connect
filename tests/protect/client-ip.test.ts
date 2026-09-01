import { describe, it, expect } from 'vitest';
import {
  IP_SOURCES,
  canonicalIp,
  clientIpFields,
  isIpAddress,
  readTrustPolicy,
  resolveClientIp,
} from '../../src/protect/client-ip.js';

/**
 * Where a client address came from, and when there is no answer.
 *
 * An address recorded against a security event attributes that event, so an address the caller chose
 * attributes it to whoever they name. Two things together make a forwarded header usable — the peer is a
 * declared proxy, and the chain is walked from the application side to the first untrusted hop — and
 * neither is sufficient alone.
 */
const PEER = '203.0.113.10';
const CLIENT = '198.51.100.99';
const PROXY = '10.0.0.7';
const POLICY = { peers: ['10.0.0.0/8'] };

describe('a peer existing is not a trust anchor', () => {
  it.each([
    'x-forwarded-for',
    'x-real-ip',
    'cf-connecting-ip',
    'true-client-ip',
    'fastly-client-ip',
    'forwarded',
  ])('ignores %s with no policy at all', (header) => {
    expect(resolveClientIp({ peer: PEER, headers: { [header]: CLIENT } })).toEqual({
      ip: PEER,
      source: 'runtime',
    });
  });

  it('ignores the chain when the peer is not a declared proxy', () => {
    // Every direct connection has a peer, so the peer's existence proves nothing. This request came
    // straight from the internet, and its forwarded header is the caller's own invention.
    expect(
      resolveClientIp({ peer: PEER, headers: { 'x-forwarded-for': CLIENT }, trustedProxy: POLICY }),
    ).toEqual({ ip: PEER, source: 'runtime' });
  });

  it('reads the chain when the peer IS a declared proxy', () => {
    expect(
      resolveClientIp({ peer: PROXY, headers: { 'x-forwarded-for': CLIENT }, trustedProxy: POLICY }),
    ).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });
});

describe('the chain is walked from the application side', () => {
  it('ignores an address the caller prepended', () => {
    // A proxy APPENDS, so the client-most entry is whatever the caller sent. Walking inward from the
    // application and stopping at the first untrusted hop is what finds the real client.
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `9.9.9.9, ${CLIENT}, 10.0.0.3` },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it('steps over several trusted hops', () => {
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `${CLIENT}, 10.1.1.1, 10.2.2.2, 10.3.3.3` },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it('falls back to the peer when every hop is one of ours', () => {
    // No client in the chain to name, so the only address this can stand behind is the observed peer.
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': '10.1.1.1, 10.2.2.2' },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: PROXY, source: 'runtime' });
  });

  it('stops at an entry that is not an address', () => {
    // A chain cannot be reasoned about past something that is not a hop, and `unknown` is a value real
    // proxies emit.
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `${CLIENT}, unknown, 10.0.0.3` },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: PROXY, source: 'runtime' });
  });

  it.each([
    // `hops` counts trusted proxies starting at the PEER, which is how the numeric form of Express's
    // trust policy counts. Pinned across the range because a deployment copying its number from an
    // Express configuration must land on the same address, and an off-by-one here silently attributes
    // events to a proxy or to a caller-supplied value.
    [1, '10.0.0.3'],
    [2, '172.16.0.1'],
    [3, CLIENT],
  ])('with hops=%i names %s as the client', (hops, expected) => {
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `${CLIENT}, 172.16.0.1, 10.0.0.3` },
      trustedProxy: { peers: ['10.0.0.0/8'], hops },
    });

    expect(resolved).toEqual({ ip: expected, source: 'trusted-proxy' });
  });

  it('falls back to the peer when the hop count runs past the chain', () => {
    // A misconfigured count must not wrap around to the client-most entry, which is the one the caller
    // controls.
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `${CLIENT}, 10.0.0.3` },
      trustedProxy: { peers: ['10.0.0.0/8'], hops: 9 },
    });

    expect(resolved).toEqual({ ip: PROXY, source: 'runtime' });
  });

  it('honours a predicate, and a throwing one grants nothing', () => {
    const allow = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { isTrusted: (ip: string) => ip.startsWith('10.') },
    });
    const throwing = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { isTrusted: () => { throw new Error('boom'); } },
    });

    expect(allow).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
    expect(throwing).toEqual({ ip: PROXY, source: 'runtime' });
  });
});

describe('a policy has to declare who is trusted', () => {
  it.each([
    ['a header name alone', { header: 'x-forwarded-for' }],
    ['nothing at all', {}],
    ['a bare true', true],
    ['a bare string', 'cloudflare'],
    ['an array', ['10.0.0.0/8']],
    ['null', null],
    ['undefined', undefined],
    ['unparseable peers', { peers: ['not-an-address'] }],
    ['a zero hop count', { hops: 0 }],
  ])('reads no policy from %s', (_label, trustedProxy) => {
    // A configuration naming only a header says which header to read without saying when reading it is
    // safe — which is exactly the case where request input silently becomes an identity.
    expect(readTrustPolicy(trustedProxy)).toBeNull();
  });

  it('reads a policy from peers, hops, or a predicate', () => {
    expect(readTrustPolicy({ peers: ['10.0.0.0/8'] })).not.toBeNull();
    expect(readTrustPolicy({ hops: 1 })).not.toBeNull();
    expect(readTrustPolicy({ isTrusted: () => true })).not.toBeNull();
  });

  it('defaults the header, and lets a policy name another', () => {
    expect(readTrustPolicy({ peers: ['10.0.0.0/8'] })?.header).toBe('x-forwarded-for');
    expect(readTrustPolicy({ peers: ['10.0.0.0/8'], header: 'X-Real-IP' })?.header).toBe('x-real-ip');
  });

  it('has no provider shortcuts', () => {
    // A provider's name does not establish that the provider overwrote the header. Several document that
    // a client-supplied value survives unless the service is configured to replace it.
    for (const provider of ['cloudflare', 'fastly', 'akamai', 'vercel']) {
      expect(readTrustPolicy({ provider }), provider).toBeNull();
    }
  });
});

describe('only real addresses are accepted', () => {
  it.each(['203.0.113.1', '0.0.0.1', '255.255.255.255', '::1', '2001:db8::1', '::ffff:203.0.113.1'])(
    'accepts %s',
    (value) => {
      expect(isIpAddress(value)).toBe(true);
    },
  );

  it.each([
    'unknown',
    'localhost',
    'example.com',
    '203.0.113',
    '203.0.113.256',
    '010.1.1.1',
    '1.2.3.4.5',
    '',
    '   ',
    ':::1',
    '2001:db8::1::2',
    'gggg::1',
    '<script>',
  ])('rejects %s', (value) => {
    expect(isIpAddress(value)).toBe(false);
  });

  it.each([undefined, null, 42, {}, []])('rejects the non-string %s', (value) => {
    expect(isIpAddress(value as never)).toBe(false);
  });

  it('never reports a value that is not an address', () => {
    // The end-to-end property: whatever the inputs, a reported address parses as one.
    const cases = [
      { peer: 'unknown' },
      { peer: PEER, headers: { 'x-forwarded-for': 'unknown' }, trustedProxy: POLICY },
      { peer: PROXY, headers: { 'x-forwarded-for': 'not-an-ip' }, trustedProxy: POLICY },
      { peer: PROXY, headers: { 'x-forwarded-for': '' }, trustedProxy: POLICY },
      { peer: '', headers: {} },
    ];

    for (const input of cases) {
      const resolved = resolveClientIp(input as never);

      expect(IP_SOURCES).toContain(resolved.source);
      if (resolved.ip !== null) expect(isIpAddress(resolved.ip), `${resolved.ip}`).toBe(true);
    }
  });

  it('matches an IPv4 policy against a dual-stack peer', () => {
    // Node reports `::ffff:10.0.0.7` for an IPv4 client on a dual-stack socket; it is the same host.
    const resolved = resolveClientIp({
      peer: '::ffff:10.0.0.7',
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it('matches an IPv6 CIDR', () => {
    const resolved = resolveClientIp({
      peer: '2001:db8::5',
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { peers: ['2001:db8::/32'] },
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it('does not match an IPv4 policy against an unrelated IPv6 peer', () => {
    const resolved = resolveClientIp({
      peer: '2001:db8::5',
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: '2001:db8::5', source: 'runtime' });
  });
});

describe('an address that identifies nobody is no address', () => {
  it.each(['0.0.0.0', '::', '::0'])('does not accept %s as a peer', (peer) => {
    // Syntactically valid, and still not an identity: the unspecified addresses mean "no particular
    // host", so a runtime reporting one has not said who connected.
    expect(resolveClientIp({ peer })).toEqual({ ip: null, source: 'unavailable' });
  });

  it('does not report an unspecified address out of a chain', () => {
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': `0.0.0.0, 10.0.0.3` },
      trustedProxy: POLICY,
    });

    expect(resolved).toEqual({ ip: PROXY, source: 'runtime' });
  });

  it('still parses them as addresses, because they are', () => {
    // The distinction is deliberate: they are well-formed, so validation accepts them and only the
    // resolution refuses to treat them as an identity.
    expect(isIpAddress('0.0.0.0')).toBe(true);
    expect(canonicalIp('::0')).toBe('::');
  });
});

describe('no transport peer means no answer', () => {
  it.each([undefined, '', '   ', 'unknown', null])('is unavailable for the peer %s', (peer) => {
    // A generic Fetch runtime exposes no transport peer. Nothing distinguishes a header a front end set
    // from one the caller sent, whatever the header is called or how it is configured.
    const resolved = resolveClientIp({
      peer,
      headers: { 'x-forwarded-for': CLIENT, 'cf-connecting-ip': CLIENT },
      trustedProxy: { peers: ['10.0.0.0/8'], header: 'cf-connecting-ip' },
    } as never);

    expect(resolved).toEqual({ ip: null, source: 'unavailable' });
  });
});

describe('the event fields', () => {
  it('omit the address entirely when there is none', () => {
    const fields = clientIpFields({ ip: null, source: 'unavailable' });

    expect(fields).toEqual({ client_ip_source: 'unavailable' });
    expect(Object.hasOwn(fields, 'client_ip')).toBe(false);
  });

  it('omit an address whose provenance does not support it', () => {
    // `unavailable` means nothing was established. An address arriving with that provenance is
    // incoherent, and reporting it would attach a value to a claim that denies it.
    expect(clientIpFields({ ip: '203.0.113.9', source: 'unavailable' } as never)).toEqual({
      client_ip_source: 'unavailable',
    });
  });

  it('carry both when an address was established', () => {
    expect(clientIpFields({ ip: PEER, source: 'runtime' })).toEqual({
      client_ip: PEER,
      client_ip_source: 'runtime',
    });
  });
});

describe('a hop-count policy works on its own', () => {
  it('trusts the peer as hop one with no CIDR list at all', () => {
    // A policy declaring only `hops` states the trust numerically: the peer IS hop one. Requiring a CIDR
    // match as well would make such a policy accepted by configuration and inert in practice.
    const resolved = resolveClientIp({
      peer: PROXY,
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { hops: 1 },
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it('still lets an address list gate the peer when one is declared', () => {
    // With `peers` present, that verdict governs: a connection from anywhere else did not arrive through
    // the declared front end, whatever the hop count says.
    const resolved = resolveClientIp({
      peer: PEER,
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { peers: ['10.0.0.0/8'], hops: 1 },
    });

    expect(resolved).toEqual({ ip: PEER, source: 'runtime' });
  });

  it('applies the same rule to a predicate-only policy', () => {
    const resolved = resolveClientIp({
      peer: PEER,
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { isTrusted: () => false, hops: 1 },
    });

    expect(resolved).toEqual({ ip: PEER, source: 'runtime' });
  });
});

describe('trust configuration fails closed', () => {
  it.each([
    ['an extra slash', ['10.0.0.0/8/typo']],
    ['a prefix that is not a number', ['10.0.0.0/eight']],
    ['a prefix wider than the family', ['10.0.0.0/33']],
    ['an IPv6 prefix wider than the family', ['2001:db8::/129']],
    ['an address that is not one', ['not-an-address']],
    ['a bracketed address', ['[2001:db8::]/32']],
    ['a non-string member', [42]],
    ['peers that is not an array', '10.0.0.0/8'],
  ])('rejects the whole policy for %s', (_label, peers) => {
    // One unparseable entry invalidates everything. A policy that silently lost a member is a policy
    // nobody wrote, and its behaviour would not reveal which half took effect.
    expect(readTrustPolicy({ peers } as never)).toBeNull();
  });

  it('rejects a mixed list rather than keeping the valid half', () => {
    expect(readTrustPolicy({ peers: ['10.0.0.0/8', 'typo'] })).toBeNull();
    expect(readTrustPolicy({ peers: ['10.0.0.0/8'] })).not.toBeNull();
  });
});

describe('addresses are parsed strictly and reported canonically', () => {
  it.each(['[::1', '::1]', '[2001:db8::1]', '[2001:db8::1]:8080'])('rejects the bracketed form %s', (value) => {
    // Brackets are rejected outright rather than stripped: stripping a delimiter whose partner may be
    // missing accepts `[::1`. A proxy emitting the bracketed form is not understood, and the walk falls
    // back to the observed peer.
    expect(isIpAddress(value)).toBe(false);
  });

  it.each(['1.2.3.4%eth0', '203.0.113.1%0'])('rejects a zone on IPv4 (%s)', (value) => {
    expect(isIpAddress(value)).toBe(false);
  });

  it.each(['fe80::1%eth0', 'fe80::1%2'])('accepts a zone on IPv6 (%s)', (value) => {
    expect(isIpAddress(value)).toBe(true);
  });

  it.each(['fe80::1%', '::1%'])('rejects an empty zone (%s)', (value) => {
    expect(isIpAddress(value)).toBe(false);
  });

  it.each([
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::FFFF:203.0.113.1', '203.0.113.1'],
    ['::1', '::1'],
    ['203.0.113.1', '203.0.113.1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
  ])('canonicalises %s to %s', (input, expected) => {
    // One spelling everywhere: two records of one client that differ only in how the address was written
    // are two records.
    expect(canonicalIp(input)).toBe(expected);
  });

  it('reports the canonical spelling, not the one it received', () => {
    const resolved = resolveClientIp({
      peer: '::ffff:10.0.0.7',
      headers: { 'x-forwarded-for': '::FFFF:198.51.100.99' },
      trustedProxy: { peers: ['10.0.0.0/8'] },
    });

    expect(resolved).toEqual({ ip: '198.51.100.99', source: 'trusted-proxy' });
  });
});

describe('every present field is validated', () => {
  it.each([
    ['a non-string header', { peers: ['10.0.0.0/8'], header: 42 }],
    ['an empty header', { peers: ['10.0.0.0/8'], header: '   ' }],
    ['a negative hop count', { peers: ['10.0.0.0/8'], hops: -1 }],
    ['a zero hop count', { peers: ['10.0.0.0/8'], hops: 0 }],
    ['a fractional hop count', { peers: ['10.0.0.0/8'], hops: 1.5 }],
    ['a non-numeric hop count', { peers: ['10.0.0.0/8'], hops: 'two' }],
    ['a non-function predicate', { peers: ['10.0.0.0/8'], isTrusted: 'nope' }],
  ])('rejects the whole policy for %s, even with valid peers', (_label, config) => {
    // Substituting a default for a malformed value, or dropping it, installs a policy the operator did
    // not write — and its behaviour would not reveal which part took effect.
    expect(readTrustPolicy(config as never)).toBeNull();
  });

  it('rejects an explicitly empty peer list', () => {
    // An empty list declares that no peer is trusted. Treating it as an absent field, so that a hop count
    // supplies the trust instead, inverts what was written.
    expect(readTrustPolicy({ peers: [] })).toBeNull();
    expect(readTrustPolicy({ peers: [], hops: 1 })).toBeNull();
  });

  it('accepts a fully valid policy using every field', () => {
    // The positive control: a rule rejecting everything would satisfy the cases above.
    const policy = readTrustPolicy({
      peers: ['10.0.0.0/8'],
      hops: 2,
      header: 'X-Real-IP',
      isTrusted: () => false,
    });

    expect(policy).not.toBeNull();
    expect(policy?.header).toBe('x-real-ip');
    expect(policy?.hops).toBe(2);
  });
});

describe('an IPv6 zone identifies an interface, so it is kept or refused', () => {
  it('keeps the zone in the canonical spelling', () => {
    // Dropping it would make two addresses on different interfaces compare equal.
    expect(canonicalIp('fe80::1%eth0')).toBe('fe80::1%eth0');
    expect(canonicalIp('FE80::0001%eth0')).toBe('fe80::1%eth0');
  });

  it('rejects a policy entry carrying a zone', () => {
    // A zone plays no part in the numeric comparison, so such an entry would trust those bits on every
    // interface — including the one it was written to exclude.
    expect(readTrustPolicy({ peers: ['fe80::1%eth0'] })).toBeNull();
    expect(readTrustPolicy({ peers: ['fe80::/10%eth0'] })).toBeNull();
  });

  it('does not let one zone stand in for another', () => {
    const resolved = resolveClientIp({
      peer: 'fe80::1%eth1',
      headers: { 'x-forwarded-for': '9.9.9.9' },
      trustedProxy: { peers: ['fe80::1%eth0'] },
    });

    expect(resolved).toEqual({ ip: 'fe80::1%eth1', source: 'runtime' });
  });

  it('still matches a zoneless prefix that covers the address', () => {
    // A CIDR is about the address bits, so `fe80::/10` covering a scoped peer is correct — it is only an
    // entry with an explicit zone that cannot be honoured.
    const resolved = resolveClientIp({
      peer: 'fe80::1%eth0',
      headers: { 'x-forwarded-for': CLIENT },
      trustedProxy: { peers: ['fe80::/10'] },
    });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });

  it.each(['fe80::1%eth0%oops', 'fe80::1%%', '::1%a%b'])('rejects more than one zone delimiter (%s)', (value) => {
    expect(isIpAddress(value)).toBe(false);
  });
});

describe('a policy is read from its own properties only', () => {
  it.each([
    ['a misspelled field', { peers: ['10.0.0.0/8'], heder: 'x-real-ip' }],
    ['an unrelated field', { peers: ['10.0.0.0/8'], trustProxy: true }],
    ['a plausible-looking extra', { peers: ['10.0.0.0/8'], trustedHops: 2 }],
  ])('rejects %s rather than ignoring it', (_label, config) => {
    // An unrecognised key is a typo, not an extension. Ignoring it uses the default header while the
    // operator believes they configured another — the quiet substitution this function exists to avoid.
    expect(readTrustPolicy(config as never)).toBeNull();
  });

  it('does not read a field inherited through the prototype chain', () => {
    // An inherited value was not written by whoever configured this object. It is ignored, so the policy
    // falls back to the default header rather than adopting one from the prototype.
    const config = Object.assign(Object.create({ header: 'x-real-ip' }), { peers: ['10.0.0.0/8'] });
    const policy = readTrustPolicy(config);

    expect(policy).not.toBeNull();
    expect(policy?.header, 'the inherited header must not be adopted').toBe('x-forwarded-for');
  });

  it.each([
    ['hops', { hops: 1 }],
    ['isTrusted', { isTrusted: () => true }],
    ['peers', { peers: ['10.0.0.0/8'] }],
  ])('does not let an inherited %s be the whole policy', (_field, proto) => {
    // With nothing of its own, the object declares no policy at all.
    expect(readTrustPolicy(Object.create(proto))).toBeNull();
  });
});

describe('a forwarded header must be sent with the request', () => {
  it('ignores a header inherited through the prototype chain', () => {
    // Prototype pollution elsewhere in an application must not be able to supply an attributed client
    // address. The peer is what the transport observed, so it stands.
    const headers = Object.create({ 'x-forwarded-for': CLIENT });
    const resolved = resolveClientIp({ peer: PROXY, headers, trustedProxy: POLICY });

    expect(resolved).toEqual({ ip: PROXY, source: 'runtime' });
  });

  it('still reads a header the request actually carried', () => {
    // The positive control: a check that rejected every header would satisfy the case above.
    const headers = Object.assign(Object.create({ 'x-forwarded-for': '203.0.113.99' }), {
      'x-forwarded-for': CLIENT,
    });
    const resolved = resolveClientIp({ peer: PROXY, headers, trustedProxy: POLICY });

    expect(resolved).toEqual({ ip: CLIENT, source: 'trusted-proxy' });
  });
});

describe('a zone identifier follows a conservative grammar', () => {
  it.each(['eth0', 'en0', 'lo', '2', '15', 'eth0.100', 'br-abc123', 'wlan_0'])('accepts %s', (zone) => {
    expect(isIpAddress(`fe80::1%${zone}`)).toBe(true);
  });

  it.each([
    ['a newline', 'bad\nzone'],
    ['a space', 'a b'],
    ['a path traversal', '../etc'],
    ['a slash', 'eth0/1'],
    ['brackets', 'zone[0]'],
    ['non-ASCII', 'ünïcode'],
    ['a quote', "zone'"],
    ['a semicolon', 'zone;drop'],
  ])('rejects %s in a zone', (_label, zone) => {
    // A zone reaches logs and retained event payloads, so anything outside the forms real runtimes
    // produce is a malformed address rather than an address with decoration.
    expect(isIpAddress(`fe80::1%${zone}`)).toBe(false);
  });

  it('rejects a zone longer than the grammar allows', () => {
    expect(isIpAddress(`fe80::1%${'a'.repeat(65)}`)).toBe(false);
    expect(isIpAddress(`fe80::1%${'a'.repeat(64)}`)).toBe(true);
  });

  it.each([
    // Both spellings of the mapped form. Its canonical form is IPv4, which has no zone to carry, so
    // keeping the address would mean discarding the scope — the one thing a zone must never do silently.
    '::ffff:203.0.113.1%eth0',
    '::FFFF:203.0.113.1%2',
    '::ffff:c000:0280%eth0',
  ])('refuses a mapped IPv4 address carrying a zone (%s)', (value) => {
    expect(isIpAddress(value)).toBe(false);
    expect(canonicalIp(value)).toBeNull();
  });

  it.each([
    ['::ffff:203.0.113.1', '203.0.113.1'],
    ['::ffff:c000:0280', '192.0.2.128'],
  ])('still accepts the zoneless mapped form %s as %s', (input, expected) => {
    // The positive control: refusing every mapped address would satisfy the case above.
    expect(canonicalIp(input)).toBe(expected);
  });

  it('never reports an address carrying a rejected zone', () => {
    const resolved = resolveClientIp({ peer: 'fe80::1%bad zone' });

    expect(resolved).toEqual({ ip: null, source: 'unavailable' });
  });
});
