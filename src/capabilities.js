import { ApiError, HOUR, ID_RE, TOKEN_RE, CAPABILITY_RE, randomHex } from './session.js';

let cachedKey;
const bytes = hex => Uint8Array.from(hex.match(/../g), value => Number.parseInt(value, 16));
const message = (id, role) => new TextEncoder().encode(`location-share:v1:${role}:${id}`);
async function key(secret) {
  if (!TOKEN_RE.test(secret || '')) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
  if (cachedKey?.secret !== secret) cachedKey = { secret, value: crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) };
  return cachedKey.value;
}
export function requestId(expiresAt) {
  // 96 random bits plus a signed expiry let the edge reject stale links without a DO call.
  return Math.ceil(expiresAt / 1000).toString(16).padStart(8, '0') + randomHex(12);
}
export async function signCapability(id, role, secret) {
  if (!ID_RE.test(id) || !['submit', 'view'].includes(role)) throw new ApiError(400, 'INVALID_REQUEST');
  const signature = await crypto.subtle.sign('HMAC', await key(secret), message(id, role));
  return 's' + [...new Uint8Array(signature)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function authenticate(id, role, token, env, now = Date.now()) {
  if (!ID_RE.test(id) || !CAPABILITY_RE.test(token || '') || !['submit', 'view'].includes(role)) throw new ApiError(401, 'UNAUTHORIZED');
  if (token.startsWith('s')) {
    if (!await crypto.subtle.verify('HMAC', await key(env.CAPABILITY_KEY), bytes(token.slice(1)), message(id, role))) throw new ApiError(401, 'UNAUTHORIZED');
    const expiresAt = Number.parseInt(id.slice(0, 8), 16) * 1000;
    if (now >= expiresAt) throw new ApiError(410, 'EXPIRED');
    // Also refuse correctly signed, implausibly far-future capabilities.
    if (expiresAt > now + HOUR + 1000) throw new ApiError(401, 'UNAUTHORIZED');
    return;
  }
  const until = Date.parse(env.LEGACY_CAPABILITIES_UNTIL || '');
  if (!Number.isFinite(until) || now >= until) throw new ApiError(401, 'UNAUTHORIZED');
  if (!env.LEGACY_LIMITER || !(await env.LEGACY_LIMITER.limit({ key: 'migration' })).success) throw new ApiError(429, 'RATE_LIMITED');
  // A bounded transition for existing links. New signed links never use this allowance.
  if (!await env.ADMISSION.get(env.ADMISSION.idFromName('global')).legacy()) throw new ApiError(429, 'RATE_LIMITED');
}

export function clientPrefix(ip) {
  if (!ip) return 'local';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4 && v4.slice(1).every(value => Number(value) <= 255)) return v4.slice(1).map(Number).join('.');
  if (!ip.includes(':')) return ip; // Local test identities; production IP is supplied by Cloudflare.
  let address = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const values = dotted[1].split('.').map(Number);
    if (values.some(value => value > 255)) return ip;
    address = address.slice(0, -dotted[1].length) + ((values[0] << 8) | values[1]).toString(16) + ':' + ((values[2] << 8) | values[3]).toString(16);
  }
  if (!/^[a-f0-9:]+$/.test(address)) return ip;
  const halves = address.split('::');
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(value => !/^[a-f0-9]{1,4}$/.test(value))) return ip;
  const canonical = groups.map(value => Number.parseInt(value, 16));
  if (canonical.slice(0, 5).every(value => value === 0) && canonical[5] === 65535) return `${canonical[6] >> 8}.${canonical[6] & 255}.${canonical[7] >> 8}.${canonical[7] & 255}`;
  return canonical.slice(0, 4).map(value => value.toString(16)).join(':') + '::/64';
}
