/**
 * Resolve a client address, and say where it came from.
 *
 * A client address is only as trustworthy as the thing that supplied it. A transport peer address is
 * observed by the runtime and cannot be set by the caller. A forwarded header is an ordinary request
 * header: anyone can send one, and it means something only when the request is known to have arrived
 * through a proxy that sets it and discards what the client sent.
 *
 * So provenance travels with the value, and nothing is trusted implicitly:
 *
 *   `runtime`        the transport peer address, observed rather than claimed
 *   `trusted-proxy`  read from a forwarded chain, through peers a policy declares trustworthy
 *   `unavailable`    no address this can stand behind
 *
 * `unavailable` is the default and a real answer. A runtime that cannot produce a verifiable address
 * should say so rather than pass on a value the caller chose: an address recorded against a security
 * event attributes that event, and one an attacker picked attributes it to whoever they name.
 *
 * ## What makes a header trustworthy
 *
 * Two things, together, and neither alone:
 *
 *   1. The PEER is a declared trusted proxy. A peer merely existing proves nothing — every direct
 *      connection has one — so a policy has to say which peers are the deployment's own front end.
 *   2. The chain is walked from the APPLICATION side inward, skipping trusted hops, and the first
 *      untrusted address is the client. Taking the client-most entry instead trusts whatever the caller
 *      prepended, because a proxy appends rather than replaces.
 *
 * There are deliberately no provider shortcuts. A provider's name does not establish that the provider
 * overwrote the header — several document that a client-supplied value survives unless the service is
 * configured to replace it, and one that does overwrite it only does so for requests that actually
 * traversed it. A shortcut worth having has to encode a policy that can be verified at run time, which
 * needs a platform adapter that positively establishes the runtime; a header name on its own does not.
 */

/**
 * The zone identifiers this accepts: interface names and numeric scope ids.
 *
 * Deliberately narrow. A zone reaches logs and retained event payloads, so anything outside the forms
 * real runtimes produce — whitespace, newlines, path separators, brackets, arbitrary Unicode — is treated
 * as a malformed address rather than passed through as part of one. Covers `eth0`, `en0`, `eth0.100`,
 * `br-abc123` and a bare scope number.
 */
const ZONE = /^[A-Za-z0-9._-]{1,64}$/;

/** The fields a trust policy may declare. Anything else is a typo, not an extension. */
const POLICY_FIELDS = Object.freeze(['peers', 'hops', 'header', 'isTrusted']);

/** Provenance values. */
export const IP_SOURCES = Object.freeze(['runtime', 'trusted-proxy', 'unavailable']);

/** The header consulted when a policy does not name one. */
const DEFAULT_FORWARDED_HEADER = 'x-forwarded-for';

/**
 * Parse an IPv4 literal into its four octets, or null.
 *
 * Leading zeros are rejected: `010` is read as decimal 10 here and as octal 8 by some resolvers, and an
 * address that means two things is not an identity.
 */
function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }

  return octets;
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups, or null.
 *
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:203.0.113.1`), which is the form Node
 * reports for an IPv4 client on a dual-stack socket.
 */
function parseIpv6(value) {
  if (value === '' || value.includes(':::')) return null;

  let head = value;
  let embedded = null;
  const lastColon = head.lastIndexOf(':');
  const tail = lastColon === -1 ? '' : head.slice(lastColon + 1);
  if (tail.includes('.')) {
    embedded = parseIpv4(tail);
    if (embedded === null) return null;
    head = head.slice(0, lastColon + 1) + '0:0';
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;

  const readGroups = (text) => {
    if (text === '') return [];
    const groups = [];
    for (const g of text.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }

    return groups;
  };

  const left = readGroups(halves[0]);
  const right = halves.length === 2 ? readGroups(halves[1]) : [];
  if (left === null || right === null) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - (left.length + right.length);
    if (fill < 1) return null;
    groups = [...left, ...new Array(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;

  if (embedded !== null) {
    groups[6] = (embedded[0] << 8) | embedded[1];
    groups[7] = (embedded[2] << 8) | embedded[3];
  }

  return groups;
}

/**
 * An address as a comparable big integer, its width, and its canonical spelling — or null when the text
 * is not an address.
 *
 * Strict about the syntax around the address, not only the address itself:
 *
 *   - The bracketed form is not accepted. A bracket is not a valid character in an address, so the group
 *     parser rejects `[::1`, `::1]` and `[2001:db8::1]:8080` without needing a rule of its own — and
 *     stripping the delimiters instead would accept the unbalanced spellings. A proxy emitting the
 *     bracketed form is therefore not understood, and the walk falls back to the observed peer.
 *   - A zone identifier (`%eth0`) is permitted only on IPv6, only once, and only in the conservative
 *     grammar below. An IPv4 literal has no zone, so `1.2.3.4%eth0` is malformed rather than an address
 *     with decoration, and `fe80::1%eth0%oops` is malformed rather than a zone containing a `%`.
 *   - A zone is KEPT in the canonical spelling. The zone is what makes a link-local address identify an
 *     interface, and dropping it would make two addresses on different interfaces compare equal. It plays
 *     no part in the numeric comparison, which is why a policy entry may not carry one.
 *
 * The canonical spelling is what callers should store and match on, so a value the validator accepted is
 * the same value everywhere: IPv4 in dotted decimal, IPv6 lowercased with the longest zero run
 * compressed, and an IPv4-mapped IPv6 address reduced to the IPv4 it carries.
 */
function toNumeric(value) {
  const text = String(value).trim();
  if (text === '') return null;

  const zoneParts = text.split('%');
  if (zoneParts.length > 2) return null;
  const addr = zoneParts[0];
  const zone = zoneParts.length === 2 ? zoneParts[1] : null;
  // A zone must name something in the accepted grammar, and only IPv6 has one.
  if (zone !== null && (!ZONE.test(zone) || !addr.includes(':'))) return null;

  const v4 = parseIpv4(addr);
  if (v4 !== null) {
    return {
      bits: 32,
      value: v4.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n),
      canonical: v4.join('.'),
    };
  }

  if (!addr.includes(':')) return null;
  const v6 = parseIpv6(addr);
  if (v6 === null) return null;

  // `::ffff:a.b.c.d` is the same host as `a.b.c.d`, so it canonicalises to the IPv4 form and compares
  // against IPv4 policies.
  //
  // A zone on one is refused rather than dropped. The canonical form of a mapped address is IPv4, and an
  // IPv4 identity has no zone to carry — so keeping the address would mean discarding the scope, which is
  // the one thing a zone must never do silently. Applies to both spellings of the mapped form.
  const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
  if (mapped) {
    if (zone !== null) return null;
    const octets = [v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff];

    return { bits: 32, value: (BigInt(v6[6]) << 16n) | BigInt(v6[7]), canonical: octets.join('.') };
  }

  return {
    bits: 128,
    value: v6.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n),
    // The zone survives: without it a link-local address does not identify an interface.
    canonical: zone === null ? canonicalIpv6(v6) : `${canonicalIpv6(v6)}%${zone}`,
  };
}

/** Lowercase hex groups with the longest run of two or more zero groups compressed to `::`. */
function canonicalIpv6(groups) {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;

  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const length = i - runStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');

  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');

  return `${head}::${tail}`;
}

/**
 * The canonical spelling of an address, or null when the text is not one.
 *
 * Exported because every surface that stores or matches an address should use the same spelling — two
 * records of one client that differ only in how the address was written are two records.
 */
export function canonicalIp(value) {
  return toNumeric(value)?.canonical ?? null;
}

/**
 * Whether `value` is a syntactically valid IP address.
 *
 * Applied to everything before it is used or reported. A forwarded chain can carry `unknown`, a hostname
 * or arbitrary text, and the resolved value is matched by rules and recorded against retained events — so
 * a string that is not an address is not an answer.
 */
export function isIpAddress(value) {
  return canonicalIp(value) !== null;
}

/**
 * Parse `1.2.3.0/24` or a bare address into a matcher, or null.
 *
 * Exactly one optional slash. `10.0.0.0/8/typo` is a typo, and reading it as `/8` would silently install
 * a policy the operator did not write.
 */
function parseCidr(entry) {
  if (typeof entry !== 'string') return null;
  // A zone plays no part in the numeric comparison, so an entry carrying one would trust every address
  // with those bits on every interface — including the one it was written to exclude.
  if (entry.includes('%')) return null;

  const parts = entry.trim().split('/');
  if (parts.length > 2) return null;

  const numeric = toNumeric(parts[0]);
  if (numeric === null) return null;

  let length = numeric.bits;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1])) return null;
    length = Number(parts[1]);
    if (length > numeric.bits) return null;
  }

  const shift = BigInt(numeric.bits - length);

  return { bits: numeric.bits, network: numeric.value >> shift, shift };
}

/**
 * Read a trusted-proxy policy, or null when the configuration declares none.
 *
 * A policy needs at least one way to recognise the deployment's own front end — `peers`, `hops`, or
 * `isTrusted`. A configuration carrying only a header name declares nothing: it says which header to
 * read without saying when reading it is safe, and that is the case where request input silently becomes
 * an identity.
 */
export function readTrustPolicy(trustedProxy) {
  if (trustedProxy === null || typeof trustedProxy !== 'object' || Array.isArray(trustedProxy)) return null;

  // Own properties only, and no unknown ones.
  //
  // A field read through the prototype chain was not written by whoever configured this object, and a key
  // this does not recognise is a typo rather than an extension — `heder: 'x-real-ip'` would otherwise be
  // ignored and the default header used, which is the quiet substitution this whole function exists to
  // avoid. Both directions matter on the configuration that decides whether request input becomes an
  // identity.
  const has = (field) => Object.hasOwn(trustedProxy, field);

  for (const key of Object.keys(trustedProxy)) {
    if (!POLICY_FIELDS.includes(key)) return null;
  }

  // Every field that is PRESENT has to be valid. Substituting a default for a malformed value, or
  // dropping it, installs a policy the operator did not write and gives them no way to tell from the
  // behaviour which part took effect.
  if (has('header') && (typeof trustedProxy.header !== 'string' || trustedProxy.header.trim() === '')) {
    return null;
  }
  if (has('hops') && (!Number.isInteger(trustedProxy.hops) || trustedProxy.hops < 1)) return null;
  if (has('isTrusted') && typeof trustedProxy.isTrusted !== 'function') return null;

  const header = has('header') ? trustedProxy.header.trim().toLowerCase() : DEFAULT_FORWARDED_HEADER;

  // Trust configuration fails closed. One unparseable entry invalidates the whole policy rather than
  // being dropped, and an EMPTY list is a declaration that no peer is trusted — not an absent field to
  // be filled in by a hop count.
  const cidrs = [];
  if (has('peers')) {
    if (!Array.isArray(trustedProxy.peers) || trustedProxy.peers.length === 0) return null;
    for (const entry of trustedProxy.peers) {
      const parsed = parseCidr(entry);
      if (parsed === null) return null;
      cidrs.push(parsed);
    }
  }

  const hops = has('hops') ? trustedProxy.hops : null;
  const predicate = has('isTrusted') ? trustedProxy.isTrusted : null;

  if (cidrs.length === 0 && hops === null && predicate === null) return null;

  return { header, cidrs, hops, predicate };
}

/** Whether an address is one of the deployment's declared proxies. */
function isTrustedPeer(policy, value) {
  const numeric = toNumeric(value);
  if (numeric === null) return false;

  for (const cidr of policy.cidrs) {
    if (cidr.bits === numeric.bits && numeric.value >> cidr.shift === cidr.network) return true;
  }

  if (policy.predicate !== null) {
    try {
      if (policy.predicate(String(value)) === true) return true;
    } catch {
      // A throwing predicate is not a grant of trust.
      return false;
    }
  }

  return false;
}

/**
 * Addresses that are syntactically valid but identify nobody.
 *
 * The unspecified addresses mean "no particular host". A runtime reporting one has not told us who
 * connected, and a chain carrying one names no client — so neither may be reported as an address, even
 * though both parse. Kept separate from parsing, because they are perfectly well-formed.
 */
const UNSPECIFIED = new Set(['0.0.0.0', '::']);

/** The canonical form of an address that identifies a host, or null. */
function identifyingIp(value) {
  const canonical = canonicalIp(value);

  return canonical === null || UNSPECIFIED.has(canonical) ? null : canonical;
}

/** The forwarded chain, in wire order (client-most first), with only real addresses kept. */
function chainFrom(headers, header) {
  // Own property only. A header inherited through the prototype chain was not sent with this request, so
  // prototype pollution elsewhere in an application must not be able to supply an attributed client
  // address.
  if (headers === null || typeof headers !== 'object' || !Object.hasOwn(headers, header)) return [];

  const raw = headers[header];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || value.trim() === '') return [];

  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Resolve the client address for a request.
 *
 * @param {{
 *   peer?: unknown,
 *   headers?: Record<string, unknown>,
 *   trustedProxy?: unknown,
 * }} input
 * @returns {{ ip: string | null, source: 'runtime' | 'trusted-proxy' | 'unavailable' }}
 */
export function resolveClientIp(input) {
  const headers = input.headers ?? {};
  // Canonical from here on, so every surface stores and matches the same spelling. An address that
  // identifies nobody is treated as no address at all.
  const peer = identifyingIp(input.peer);
  const policy = readTrustPolicy(input.trustedProxy);

  // No peer means no transport-level anchor. A forwarded header here is indistinguishable from one the
  // caller wrote, whatever it is called, so there is nothing to report.
  if (peer === null) return { ip: null, source: 'unavailable' };

  if (policy === null) return { ip: peer, source: 'runtime' };

  // Which part of the policy gates the peer.
  //
  // A policy declaring `peers` or `isTrusted` names the deployment's own front end, so that verdict
  // governs: a connection from anywhere else did not arrive through it. A policy declaring only `hops`
  // makes the statement numerically instead — the peer IS hop one — so the count is itself the trust and
  // has to be evaluated on its own. Requiring a CIDR match there would make a hops-only policy accepted
  // by configuration and inert in practice.
  const gatedByAddress = policy.cidrs.length > 0 || policy.predicate !== null;
  const peerTrusted = gatedByAddress ? isTrustedPeer(policy, peer) : policy.hops !== null;
  if (!peerTrusted) return { ip: peer, source: 'runtime' };

  const chain = chainFrom(headers, policy.header);
  if (chain.length === 0) return { ip: peer, source: 'runtime' };

  if (policy.hops !== null) {
    // `hops` counts trusted proxies starting AT THE PEER, matching the numeric form of Express's trust
    // policy. So `hops: 1` means the peer is the only proxy and the client is the application-most entry
    // in the chain; `hops: 2` means the peer plus one charted hop; and so on. Counting from the chain
    // instead would be off by one against every deployment that copied its number from an Express
    // configuration.
    const index = chain.length - policy.hops;
    const candidate = index >= 0 ? chain[index] : undefined;

    const canonical = identifyingIp(candidate);

    return canonical === null ? { ip: peer, source: 'runtime' } : { ip: canonical, source: 'trusted-proxy' };
  }

  // Walk inward from the application side, stepping over hops the policy trusts. The first address that
  // is not one of ours is the client. An entry that is not an address at all stops the walk: the chain
  // cannot be reasoned about past something that is not a hop.
  for (let i = chain.length - 1; i >= 0; i--) {
    const canonical = identifyingIp(chain[i]);
    if (canonical === null) return { ip: peer, source: 'runtime' };
    if (!isTrustedPeer(policy, canonical)) return { ip: canonical, source: 'trusted-proxy' };
  }

  // Every hop was one of ours, which leaves no client in the chain to name.
  return { ip: peer, source: 'runtime' };
}

/**
 * The event fields for a resolved address.
 *
 * `client_ip` is omitted entirely when there is none, rather than sent as null or an empty string: a
 * field that is present but empty reads as a failed lookup of a real address. The provenance is always
 * present, because "this could not be established" is the part a reader needs.
 */
export function clientIpFields(resolved) {
  return resolved.ip === null
    ? { client_ip_source: resolved.source }
    : { client_ip: resolved.ip, client_ip_source: resolved.source };
}
