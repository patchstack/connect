import { describe, expect, it } from 'vitest';
import { fromFetchRequest } from '../../src/protect/engine/fetch.js';
import { createProtection } from '../../src/protect/runtime.js';

// multipart/form-data bodies are parsed so field-scoped rules (post.<field>) and `raw` match
// uploads — e.g. a `<script>` in a text field or a `__proto__` field name — and file parts
// surface via files.<field> (the filename).

const BOUNDARY = '----psboundary';
function multipart(parts: Array<{ name: string; value: string; filename?: string; type?: string }>) {
  const lines: string[] = [];
  for (const p of parts) {
    lines.push(`--${BOUNDARY}`);
    lines.push(
      `Content-Disposition: form-data; name="${p.name}"` + (p.filename !== undefined ? `; filename="${p.filename}"` : ''),
    );
    if (p.type) lines.push(`Content-Type: ${p.type}`);
    lines.push('');
    lines.push(p.value);
  }
  lines.push(`--${BOUNDARY}--`, '');
  return lines.join('\r\n');
}

const req = (body: string) =>
  new Request('https://app/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });

describe('multipart/form-data parsing', () => {
  it('exposes text fields as post.* and file parts as files.*', async () => {
    const shaped: any = await fromFetchRequest(
      req(
        multipart([
          { name: 'title', value: '<script>alert(1)</script>' },
          { name: '__proto__[polluted]', value: 'yes' },
          { name: 'avatar', value: '<svg onload=alert(1)>', filename: 'evil.svg', type: 'image/svg+xml' },
        ]),
      ),
    );
    expect(shaped.body.title).toBe('<script>alert(1)</script>');
    expect(shaped.body['__proto__[polluted]']).toBe('yes');
    // File parts are now captured as { filename, type, content } (content inspection), not a bare filename.
    expect(shaped.files.avatar).toMatchObject({ filename: 'evil.svg', type: 'image/svg+xml', content: '<svg onload=alert(1)>' });
    expect(shaped._rawBody).toContain('__proto__');
  });

  it('tolerates LF-only line endings and collects duplicate field names', async () => {
    const lfBody = [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="tag"',
      '',
      'first',
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="tag"',
      '',
      '<script>x</script>',
      `--${BOUNDARY}--`,
      '',
    ].join('\n'); // bare LF, not CRLF
    const shaped: any = await fromFetchRequest(req(lfBody));
    expect(shaped.body.tag).toEqual(['first', '<script>x</script>']); // duplicates collected
    expect(shaped._rawBody).toContain('<script>');
  });

  it.each([
    ['a decoy parameter whose name ends in boundary', `multipart/form-data; xboundary=decoy; boundary=${BOUNDARY}`],
    ['a decoy boundary= inside an earlier quoted value', `multipart/form-data; note="a;boundary=decoy"; boundary=${BOUNDARY}`],
    ['a quoted boundary', `multipart/form-data; boundary="${BOUNDARY}"`],
  ])('splits on the boundary the application parses, past %s', async (_label, contentType) => {
    const body = multipart([
      { name: 'title', value: 'hello' },
      { name: 'comment', value: '<script>x</script>' },
      { name: 'avatar', value: '<svg onload=alert(1)>', filename: 'a.svg', type: 'image/svg+xml' },
    ]);
    const request = () => new Request('https://app/upload', { method: 'POST', headers: { 'content-type': contentType }, body });

    const form = await request().formData();
    const shaped: any = await fromFetchRequest(request());
    expect(shaped.body.title).toBe(form.get('title'));
    expect(shaped.body.comment).toBe(form.get('comment'));
    expect(shaped.files.avatar).toMatchObject({ filename: (form.get('avatar') as File).name, type: 'image/svg+xml' });
  });

  it('a post.<field> rule blocks a malicious multipart field', async () => {
    const rules = {
      firewall: [{ id: 'xss', title: 'xss', rule_v2: [{ parameter: ['post.title'], match: { type: 'contains', value: '<script' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    const p = await createProtection({ rules, mode: 'block' });
    const guard = p.fetchGuard();
    expect(await guard(req(multipart([{ name: 'title', value: '<script>x</script>' }])))).not.toBeNull();
    expect(await guard(req(multipart([{ name: 'title', value: 'a normal title' }])))).toBeNull();
  });
});
