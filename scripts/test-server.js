import { spawn } from 'node:child_process';
const child = spawn('wrangler', ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', '8790', '--inspector-port', '9230', '--persist-to', '.wrangler/test-state'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
