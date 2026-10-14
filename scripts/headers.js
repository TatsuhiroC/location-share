import { readFile, writeFile } from 'node:fs/promises';
import { SECURITY } from '../src/security.js';
const headers = Object.entries(SECURITY).filter(([key]) => key !== 'Cache-Control');
const expected = '/*\n' + headers.map(([key, value]) => `  ${key}: ${value}`).join('\n') + '\n  Cache-Control: no-cache\n';
const file = new URL('../public/_headers', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== expected) throw new Error('Static security headers are out of date. Run npm run headers:sync.');
} else { await writeFile(file, expected); }
