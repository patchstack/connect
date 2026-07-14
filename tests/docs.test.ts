import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PROMPT_PATTERN = /^> (Add Patchstack dependency vulnerability monitoring:.+)$/m;

describe('installation documentation', () => {
  it('keeps every documented install prompt identical to the field-tested artifact', async () => {
    const testedPrompt = (await readFile(path.join(REPO_ROOT, 'field-test', 'prompt.txt'), 'utf8')).trimEnd();

    for (const document of ['README.md', 'GETTING-STARTED.md']) {
      const contents = await readFile(path.join(REPO_ROOT, document), 'utf8');
      const documentedPrompt = contents.match(INSTALL_PROMPT_PATTERN)?.[1];

      expect(documentedPrompt, `${document} must contain the install prompt`).toBe(testedPrompt);
    }
  });
});
