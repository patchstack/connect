import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';

const template = new URL('../index.template.html', import.meta.url);
const target = new URL('../index.html', import.meta.url);
const force = process.argv.includes('--reset');

try {
  await copyFile(template, target, force ? 0 : constants.COPYFILE_EXCL);
  console.log(`Prepared ${target.pathname}${force ? ' from the clean template' : ''}.`);
} catch (error) {
  if (!force && error?.code === 'EEXIST') {
    console.log('Kept the existing generated index.html.');
  } else {
    throw error;
  }
}
