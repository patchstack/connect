import { setOwn } from './own.js';

/**
 * A `Cookie` header as name → value.
 *
 * A value wrapped in double quotes loses them, as cookie parsers strip them before an application reads
 * the value. A name sent more than once keeps every value, as an array in the order sent: parsers differ
 * on whether the first or the last one wins, so a rule on that cookie inspects all of them.
 */
export function parseCookieHeader(header) {
  const cookies = {};
  if (typeof header !== 'string' || header === '') return cookies;

  const repeated = new Map();
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === '') continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1);

    if (!Object.hasOwn(cookies, name)) {
      setOwn(cookies, name, value);
    } else {
      let values = repeated.get(name);
      if (values === undefined) {
        values = [cookies[name]];
        repeated.set(name, values);
        setOwn(cookies, name, values);
      }
      values.push(value);
    }
  }
  return cookies;
}
