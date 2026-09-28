import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { dispositionFields, parseMultipart } from '../../src/protect/engine/fetch.js';

/**
 * A multipart part is filed under the field name its Content-Disposition declares — read as the
 * application's own form parser would read it, whatever the order, quoting or case of its parameters.
 * A rule addressed to `post.<field>` or `files.<field>` then sees the value the application receives.
 */

const BOUNDARY = 'psBoundary7MA4YWxk';
const part = (disposition: string, content = 'VALUE', type = 'text/plain') =>
  [`--${BOUNDARY}`, `Content-Disposition: ${disposition}`, `Content-Type: ${type}`, '', content].join('\r\n');
const body = (...parts: string[]) => [...parts, `--${BOUNDARY}--`, ''].join('\r\n');

describe('the names a Content-Disposition declares', () => {
  it.each([
    ['name before filename', 'form-data; name="cmd"; filename="a.php"', ['cmd'], 'a.php'],
    ['filename before name', 'form-data; filename="a.php"; name="cmd"', ['cmd'], 'a.php'],
    ['unquoted values', 'form-data; name=cmd; filename=a.php', ['cmd'], 'a.php'],
    ['upper-case parameter names', 'form-data; NAME="cmd"; FILENAME="a.php"', ['cmd'], 'a.php'],
    ['spaces around the equals sign', 'form-data; name = "cmd"; filename = "a.php"', ['cmd'], 'a.php'],
    ['an escaped quote in a name', 'form-data; name="c\\"md"', ['c"md'], undefined],
    ['a semicolon inside a quoted name', 'form-data; name="a;b"', ['a;b'], undefined],
    ['a filename lookalike inside a quoted name', 'form-data; name="x; filename=evil.php"', ['x; filename=evil.php'], undefined],
    ['an extended filename alone', "form-data; name=\"cmd\"; filename*=UTF-8''a%20b.php", ['cmd'], 'a b.php'],
    ['an extended filename beside a plain one', "form-data; name=\"cmd\"; filename=\"x.txt\"; filename*=UTF-8''y.php", ['cmd'], 'y.php'],
    ['an empty filename', 'form-data; name="field"; filename=""', ['field'], ''],
    ['stray text after a quoted value', 'form-data; name="cmd" x; filename="a.php"', ['cmd'], 'a.php'],
    ['no filename', 'form-data; name="field"', ['field'], undefined],
  ])('reads %s', (_label, disposition, names, filename) => {
    expect(dispositionFields(disposition)).toEqual({ names, filename });
  });

  it('keeps every name a repeated parameter could be read as', () => {
    // Parsers disagree on which one wins, so a rule on either has to see the value.
    expect(dispositionFields('form-data; name="first"; name="second"').names).toEqual(['first', 'second']);
  });

  it('still reads a name placed after a great many other parameters', () => {
    const padded = `form-data; ${'x=1; '.repeat(5_000)}name="late"`;
    expect(dispositionFields(padded).names).toEqual(['late']);
  });

  it('reads a long, hostile value in linear time', () => {
    const hostile = `form-data; ${'name="a\\"; '.repeat(50_000)}`;
    const startedAt = performance.now();
    dispositionFields(hostile);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe('a multipart body', () => {
  it('files an upload under its field, not its filename, whatever the order', () => {
    const { body: fields, files } = parseMultipart(body(part('form-data; filename="a.php"; name="cmd"', '<?php')), BOUNDARY);

    expect(Object.keys(files)).toEqual(['cmd']);
    expect(files.cmd).toMatchObject({ filename: 'a.php', content: '<?php' });
    expect(fields).toEqual({});
  });

  it('files a plain field under its name', () => {
    const { body: fields, files } = parseMultipart(body(part('form-data; name=note', 'hello')), BOUNDARY);

    expect(fields).toEqual({ note: 'hello' });
    expect(files).toEqual({});
  });

  it('files a part with a repeated name under each', () => {
    const { body: fields } = parseMultipart(body(part('form-data; name="first"; name="second"', 'v')), BOUNDARY);

    expect(fields).toEqual({ first: 'v', second: 'v' });
  });
});

describe('parsing a hostile body', () => {
  /** One upload part carrying `names` distinct names and a header padded in proportion. */
  const hostile = (names: number) =>
    body(
      part(
        `form-data; ${Array.from({ length: names }, (_, i) => `name="f${i}"`).join('; ')}; filename="a.txt"\r\nX-Pad: ${'p'.repeat(names * 10)}`,
      ),
    );
  const timed = (input: string) => {
    const startedAt = performance.now();
    parseMultipart(input, BOUNDARY);
    return performance.now() - startedAt;
  };

  it('grows linearly with the size of a part, however many names it declares', () => {
    // Compared across sizes rather than against a fixed budget, so the verdict is about how the work
    // grows, not how fast this machine is. Warm up first, and take the best of a few runs.
    const best = (names: number) => {
      const input = hostile(names);
      timed(input);
      return Math.min(timed(input), timed(input), timed(input));
    };
    const small = best(2_000);
    const large = best(16_000);

    // Eight times the input: linear work takes about eight times as long, and a per-name rescan of the
    // header about sixty-four. Twenty-four leaves wide room for noise either way.
    expect(large / Math.max(small, 0.5)).toBeLessThan(24);
  });

  it('files the part under every name, with its metadata read once', () => {
    const { files } = parseMultipart(hostile(50), BOUNDARY);

    expect(Object.keys(files)).toHaveLength(50);
    expect(files.f0).toMatchObject({ filename: 'a.txt', type: 'text/plain' });
    expect(files.f49).toBe(files.f0);
  });
});

describe('a rule on an upload field', () => {
  it('sees the upload however its parameters are ordered', async () => {
    const protection: any = await createProtection({
      mode: 'block',
      onError: () => {},
      rules: {
        firewall: [{ id: 'upload-ext', rule_v2: [{ parameter: 'files.cmd', match: { type: 'contains', value: '.php' } }] }],
        whitelists: [],
        whitelist_keys: {},
      },
    });
    const guard = protection.fetchGuard();
    const send = (disposition: string) =>
      guard(new Request('http://app.test/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: body(part(disposition, '<?php', 'application/x-php')),
      }));

    for (const disposition of ['form-data; name="cmd"; filename="a.php"', 'form-data; filename="a.php"; name="cmd"', 'form-data; name=cmd; filename=a.php']) {
      expect((await send(disposition))?.status, disposition).toBe(403);
    }
    expect(await send('form-data; name="cmd"; filename="a.png"')).toBeNull();
  });
});
