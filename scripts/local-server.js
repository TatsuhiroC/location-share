import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const testing = process.argv.includes('--test');
const state = testing ? await mkdtemp(join(tmpdir(), 'location-share-tests-')) : null;
const args = ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', testing ? '8790' : '8787', '--inspector-port', testing ? '9230' : '9229', '--var', `CAPABILITY_KEY:${'e'.repeat(64)}`];
// The publicly known development key above is for local development only; production has no fallback key.
if (state) args.push('--persist-to', state);
const child = spawn('wrangler', args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', async code => { if (state) await rm(state, { recursive: true, force: true }); process.exit(code ?? 1); });
