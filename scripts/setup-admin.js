import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Only the SHA-256 hash goes to Cloudflare. Never write the raw capability to a file.
const key = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(key).digest('hex');
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const child = spawn('wrangler', ['secret', 'put', 'CREATOR_KEY_HASH', '--env='], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(hash + '\n');
const code = await new Promise(resolve => child.on('exit', resolve));
if (code !== 0) process.exit(code ?? 1);
// This is the intentional private, user-facing result of this setup command.
console.log('\n专属管理入口（仅供自己保存，不要发给对方）：');
console.log(`${config.vars.PUBLIC_ORIGIN}/#admin/${key}`);
console.log('如重新运行本命令，旧管理入口将失效；已有分享及查看链接不受影响。');
