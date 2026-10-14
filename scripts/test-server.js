import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Public, test-only capability; the test runner provides it only to the local environment.
const creator = 'e'.repeat(64);
const child = spawn('wrangler', ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', '8790', '--inspector-port', '9230', '--persist-to', '.wrangler/test-state', '--var', `CREATOR_KEY_HASH:${createHash('sha256').update(creator).digest('hex')}`], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
