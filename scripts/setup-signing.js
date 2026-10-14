import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'secret', 'put', 'CAPABILITY_KEY', '--env='], { stdio: ['pipe', 'inherit', 'inherit'] });
// Never print, save or pass the server signing secret on the command line.
child.stdin.end(randomBytes(32).toString('hex') + '\n');
child.on('exit', code => process.exit(code ?? 1));
