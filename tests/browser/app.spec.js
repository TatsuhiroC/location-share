import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

async function isolateClient(context) {
  const client = `browser-${randomBytes(8).toString('hex')}`;
  await context.route('**/api/**', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': client } }));
}
async function vectorStyles(context) {
  await context.route('https://tiles.openfreemap.org/**', route => {
    const theme = route.request().url().split('/').at(-1);
    const color = theme === 'dark' ? '#243c37' : theme === 'liberty' ? '#cadfe2' : '#f5f6ef';
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': color } }] } });
  });
}
// Integration tests never download third-party map tiles or fonts.
test.beforeEach(async ({ context }) => {
  await isolateClient(context); await vectorStyles(context);
  await context.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG.sync.write(new PNG({ width: 256, height: 256 })) }));
});

async function create(request, extra = {}) {
  const response = await request.post('/api/requests', {
    headers: { 'CF-Connecting-IP': `test-${randomBytes(8).toString('hex')}` },
    data: { initiator: '小陈', ...extra }
  });
  expect(response.status()).toBe(201);
  return response.json();
}
const auth = token => ({ Authorization: `Bearer ${token}`, 'CF-Connecting-IP': `api-${randomBytes(8).toString('hex')}` });
const link = (data, role) => `/#${role}/${data.id}/${role === 'view' ? data.viewToken : data.submitToken}`;

test('simple creation, independently decoded QR, explicit consent, automatic map, refresh, deletion', async ({ browser, baseURL }) => {
  const owner = await browser.newContext({ baseURL });
  await isolateClient(owner);
  await owner.route('https://tiles.openfreemap.org/**', route => route.abort());
  const sharer = await browser.newContext({ baseURL, permissions: ['geolocation'], geolocation: { latitude: 31.2304, longitude: 121.4737, accuracy: 12 } });
  const ownerPage = await owner.newPage();
  await ownerPage.goto('/');
  await owner.route('https://tile.openstreetmap.org/**', route => route.abort());
  await ownerPage.getByLabel('分享发起人', { exact: false }).fill('小陈');
  await ownerPage.getByRole('button', { name: '生成临时链接' }).click();
  await expect(ownerPage.getByRole('heading', { name: '链接准备好了' })).toBeVisible();
  await expect(ownerPage.locator('#share-qr svg')).toBeVisible();
  const shareUrl = await ownerPage.getByLabel('发给对方的分享链接').inputValue();
  expect(ownerPage.url()).toContain('#view/');
  const qr = PNG.sync.read(await ownerPage.locator('#share-qr').screenshot());
  expect(jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height)?.data).toBe(shareUrl);
  await expect(ownerPage.getByText('等待一次位置分享')).toBeVisible();
  const sharePage = await sharer.newPage();
  let submissions = 0;
  sharePage.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/location')) submissions++; });
  await sharePage.goto(shareUrl);
  await expect(sharePage.getByRole('button', { name: '允许分享当前位置' })).toBeVisible();
  expect(submissions).toBe(0);
  await sharePage.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(sharePage.getByRole('heading', { name: '位置已发送' })).toBeVisible();
  expect(submissions).toBe(1);
  // The sender remains on the original generated page; no manual refresh or navigation.
  await expect(ownerPage.locator('#latitude')).toHaveText('31.230400', { timeout: 12000 });
  await expect(ownerPage.locator('#position-map')).toBeVisible();
  await expect(ownerPage.locator('#position-map path.leaflet-interactive')).toHaveCount(2);
  await expect(ownerPage.locator('#position-map path.leaflet-interactive').last()).toBeVisible();
  await expect(ownerPage.locator('#position-map')).toContainText('OpenStreetMap');
  await expect(ownerPage.locator('#map-note')).toContainText('底图加载失败', { timeout: 16000 });
  const amap = new URL(await ownerPage.locator('#amap-link').getAttribute('href'));
  expect(amap.searchParams.get('position')).toBe('121.4737,31.2304');
  expect(amap.searchParams.get('coordinate')).toBe('wgs84');
  expect(amap.searchParams.get('callnative')).toBe('1');
  const baidu = new URL(await ownerPage.locator('#baidu-link').getAttribute('href'));
  expect(baidu.searchParams.get('location')).toBe('31.2304,121.4737');
  expect(baidu.searchParams.get('coord_type')).toBe('wgs84');
  expect(new URL(await ownerPage.locator('#google-link').getAttribute('href')).searchParams.get('query')).toBe('31.2304,121.4737');
  expect(new URL(await ownerPage.locator('#apple-link').getAttribute('href')).searchParams.get('ll')).toBe('31.2304,121.4737');
  await expect(ownerPage.locator('#accuracy')).toHaveText('约 12 米');
  await ownerPage.reload();
  await expect(ownerPage.locator('#longitude')).toHaveText('121.473700');
  await ownerPage.getByRole('button', { name: '删除请求与位置' }).click();
  await ownerPage.getByRole('button', { name: '确认删除' }).click();
  await expect(ownerPage.getByRole('heading', { name: '请求已删除' })).toBeVisible();
  await sharePage.goto(shareUrl);
  await expect(sharePage.getByText('这个链接已失效、已删除，或地址不完整。')).toBeVisible();
  await owner.close(); await sharer.close();
});

test('permission denial sends no position and leaves request waiting', async ({ page, request }) => {
  const data = await create(request);
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_ok, fail) => fail({ code: 1 });
  });
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(page.getByRole('alert')).toContainText('定位权限未允许，没有发送位置');
  const response = await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) });
  expect((await response.json()).position).toBeNull();
});

test('cancelled geolocation callback cannot later send a position', async ({ page, request }) => {
  const data = await create(request);
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = ok => { window.delayedFix = ok; }; });
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await page.getByRole('button', { name: '取消获取位置' }).click();
  await page.evaluate(() => window.delayedFix({ coords: { latitude: 31, longitude: 121, accuracy: 20 }, timestamp: Date.now() }));
  await expect(page.locator('#share-feedback')).toHaveText('已取消，没有发送位置。');
  const response = await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) });
  expect((await response.json()).position).toBeNull();
});

test('lost receipt retries the same snapshot without duplicating the submission', async ({ page, request }) => {
  const data = await create(request);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 31, longitude: 121, accuracy: 10 });
  let lost = false;
  await page.route('**/location', async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(page.getByRole('button', { name: '重试发送这次位置' })).toBeVisible();
  await page.getByRole('button', { name: '重试发送这次位置' }).click();
  await expect(page.getByRole('heading', { name: '位置已发送' })).toBeVisible();
  const result = await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) });
  expect((await result.json()).position.latitude).toBe(31);
});

test('capabilities, bounded body, cross-origin mutation, and no-store headers on real Worker', async ({ request }) => {
  const data = await create(request);
  const root = `/api/requests/${data.id}`;
  expect((await request.get(root, { headers: auth(data.submitToken) })).status()).toBe(401);
  expect((await request.get(`${root}/info`, { headers: auth(data.viewToken) })).status()).toBe(401);
  expect((await request.delete(root, { headers: auth(data.submitToken) })).status()).toBe(401);
  expect((await request.get(root, { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } })).status()).toBe(401);
  expect((await request.delete(root, { headers: { ...auth(data.viewToken), Origin: 'https://other.example' } })).status()).toBe(403);
  const body = { latitude: 31, longitude: 121, accuracy: 10, timestamp: Date.now(), consent: true, submissionId: 'a'.repeat(32) };
  expect((await request.post(`${root}/location`, { headers: auth(data.submitToken), data: { ...body, latitude: 200 } })).status()).toBe(400);
  expect((await request.post(`${root}/location`, { headers: auth(data.submitToken), data: { ...body, padding: 'a'.repeat(5000) } })).status()).toBe(413);
  const first = await request.post(`${root}/location`, { headers: auth(data.submitToken), data: body });
  expect(first.status()).toBe(200);
  expect((await request.post(`${root}/location`, { headers: auth(data.submitToken), data: { ...body, submissionId: 'b'.repeat(32) } })).status()).toBe(409);
  const read = await request.get(root, { headers: auth(data.viewToken) });
  expect(read.headers()['cache-control']).toBe('no-store');
  const info = await request.get(`${root}/info`, { headers: auth(data.submitToken) });
  expect((await info.json()).position).toBeUndefined();
  expect((await request.delete(root, { headers: auth(data.viewToken) })).status()).toBe(200);
  expect((await request.get(root, { headers: auth(data.viewToken) })).status()).toBe(404);
});

test('request text remains text; mobile layout has no horizontal overflow', async ({ page, request }) => {
  const data = await create(request, { initiator: '<img src=x onerror=alert(1)>' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(link(data, 'share'));
  await expect(page.locator('#share-initiator')).toHaveText('<img src=x onerror=alert(1)>');
  expect(await page.locator('#share-initiator img').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '生成临时分享链接' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('creation limit enforces five requests per minute per client', async ({ request }) => {
  const client = `limit-${randomBytes(8).toString('hex')}`;
  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/requests', { headers: { 'CF-Connecting-IP': client }, data: {} });
    expect(response.status()).toBe(i < 5 ? 201 : 429);
  }
});

test('invalid input cannot exhaust the valid creation quota', async ({ request }) => {
  const client = `failed-${randomBytes(8).toString('hex')}`;
  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/requests', { headers: { 'CF-Connecting-IP': client }, data: { initiator: 'a'.repeat(61) } });
    expect(response.status()).toBe(400);
  }
  expect((await request.post('/api/requests', { headers: { 'CF-Connecting-IP': client }, data: {} })).status()).toBe(201);
});

test('home has one optional field; anonymous creation has fixed one-hour expiry', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('form input')).toHaveCount(1);
  await expect(page.getByLabel('分享发起人', { exact: false })).toBeVisible();
  expect(await page.getByLabel('分享发起人', { exact: false }).getAttribute('required')).toBeNull();
  expect(await page.locator('#creator-key, #purpose, #hours').count()).toBe(0);
  await page.getByRole('button', { name: '生成临时链接' }).click();
  await expect(page.locator('#share-qr svg')).toBeVisible();
  await expect(page.locator('#view-initiator')).toHaveText('未填写');
  const data = await create(request, { initiator: '', hours: 24 });
  const response = await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) });
  const info = await response.json();
  expect(info.initiator).toBe(''); expect(info.expiresAt - info.createdAt).toBe(3600000);
  await page.reload();
  await expect(page.locator('#share-qr svg')).toBeVisible();
});

test('mobile APP links preserve WGS84; map and QR do not overflow on narrow screens', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'iPhone Safari' }));
  const data = await create(request);
  const receipt = await request.post(`/api/requests/${data.id}/location`, { headers: auth(data.submitToken), data: { latitude: 31, longitude: 121, accuracy: 10, timestamp: Date.now(), consent: true, submissionId: 'c'.repeat(32) } });
  expect(receipt.status()).toBe(200);
  await page.goto(link(data, 'view'));
  await expect(page.locator('#position-map')).toBeVisible();
  const baidu = new URL(await page.locator('#baidu-link').getAttribute('href'));
  expect(baidu.protocol).toBe('baidumap:'); expect(baidu.searchParams.get('coord_type')).toBe('wgs84');
  expect(await page.locator('#baidu-web').getAttribute('href')).toContain('https://api.map.baidu.com/marker');
  expect(await page.locator('#send-panel').isHidden()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function useFixes(page, fixes) {
  await page.addInitScript(samples => {
    let index = 0;
    navigator.geolocation.getCurrentPosition = ok => {
      const fix = samples[Math.min(index++, samples.length - 1)];
      ok({ coords: { latitude: fix.latitude ?? 31, longitude: 121, accuracy: fix.accuracy }, timestamp: Date.now() });
    };
  }, fixes);
}

test('coarse fix is held locally until confirmed; receiver sees a warning and the full accuracy area', async ({ page, request }) => {
  const data = await create(request);
  await useFixes(page, [{ accuracy: 2000 }]);
  let submissions = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/location')) submissions++; });
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(page.getByRole('dialog', { name: '要获取更精确的位置吗？' })).toBeVisible();
  await expect(page.locator('#accuracy-estimate')).toContainText('2.0 公里');
  expect(submissions).toBe(0);
  expect((await (await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) })).json()).position).toBeNull();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByText('如何开启精确位置？', { exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('网页无法替你开启权限');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '仍发送当前大致位置' }).click();
  await expect(page.getByRole('heading', { name: '位置已发送' })).toBeVisible();
  expect(submissions).toBe(1);
  const stored = await (await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) })).json();
  expect(stored.position.accuracy).toBe(2000);
  await page.goto(link(data, 'view'));
  await expect(page.locator('#position-precision')).toContainText('本次定位精度较低');
  await expect(page.locator('#position-precision')).toContainText('估算中心');
  // Coarse positions must show their uncertainty rather than an enlarged pinpoint.
  const area = await page.locator('#position-map path.leaflet-interactive').first().boundingBox();
  const viewport = await page.locator('#position-map').boundingBox();
  expect(area.width).toBeGreaterThan(100); expect(area.width).toBeLessThan(viewport.width);
});

test('retry after a coarse result sends only the newly acquired better fix', async ({ page, request }) => {
  const data = await create(request);
  await useFixes(page, [{ accuracy: 2000, latitude: 31 }, { accuracy: 12, latitude: 32 }]);
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '重新获取更精确的位置' }).click();
  await expect(page.getByRole('heading', { name: '位置已发送' })).toBeVisible();
  const stored = await (await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) })).json();
  expect(stored.position.latitude).toBe(32); expect(stored.position.accuracy).toBe(12);
});

for (const dismissal of ['button', 'escape']) {
  test(`retry that is still coarse does not upload; ${dismissal} cancels without sending`, async ({ page, request }) => {
    const data = await create(request);
    await useFixes(page, [{ accuracy: 2000 }]);
    let submissions = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/location')) submissions++; });
    await page.goto(link(data, 'share'));
    await page.getByRole('button', { name: '允许分享当前位置' }).click();
    await page.getByRole('button', { name: '重新获取更精确的位置' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(submissions).toBe(0);
    if (dismissal === 'button') await page.getByRole('button', { name: '暂不分享', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('#share-feedback')).toHaveText('已取消，没有发送位置。');
    await expect(page.getByRole('button', { name: '允许分享当前位置' })).toBeEnabled();
    expect((await (await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) })).json()).position).toBeNull();
  });
}

test('a coarse sample that becomes stale while awaiting confirmation is never sent', async ({ page, request }) => {
  const data = await create(request);
  await useFixes(page, [{ accuracy: 2000 }]);
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '允许分享当前位置' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 300001; });
  await page.getByRole('button', { name: '仍发送当前大致位置' }).click();
  await expect(page.locator('#share-error')).toContainText('定位结果已超过五分钟');
  expect((await (await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) })).json()).position).toBeNull();
});

test('map styles switch, keep the location marker, and retain the selected preference', async ({ page, request }) => {
  const data = await create(request);
  const response = await request.post(`/api/requests/${data.id}/location`, { headers: auth(data.submitToken), data: { latitude: 31, longitude: 121, accuracy: 10, timestamp: Date.now(), consent: true, submissionId: 'a'.repeat(32) } });
  expect(response.status()).toBe(200);
  await page.goto(link(data, 'view'));
  await expect(page.locator('#position-map')).toHaveAttribute('data-basemap', /positron|fallback/, { timeout: 16000 });
  if (await page.locator('#position-map').getAttribute('data-basemap') === 'fallback') {
    await expect(page.locator('#map-style')).toBeDisabled();
    await expect(page.locator('#map-note')).toContainText('基础地图');
    await expect(page.locator('#position-map path.leaflet-interactive')).toHaveCount(2);
    return;
  }
  await expect(page.locator('#position-map canvas')).toBeVisible();
  await expect(page.locator('#position-map')).toContainText('OpenFreeMap');
  await expect(page.locator('#map-style')).toHaveValue('positron');
  await page.getByLabel('地图风格', { exact: true }).selectOption('dark');
  await expect(page.locator('#position-map')).toHaveAttribute('data-basemap', 'dark');
  const capture = PNG.sync.read(await page.locator('#position-map').screenshot());
  const index = (80 * capture.width + 80) * 4;
  expect(capture.data[index]).toBeLessThan(80); // The actual GL canvas renders a dark basemap.
  await expect(page.locator('#position-map path.leaflet-interactive')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('#position-map')).toHaveAttribute('data-basemap', 'dark', { timeout: 16000 });
  await expect(page.getByLabel('地图风格', { exact: true })).toHaveValue('dark');
});

test('without WebGL, the basic map still displays position and precision', async ({ page, request }) => {
  const data = await create(request);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : original.call(this, type, ...args); };
  });
  await request.post(`/api/requests/${data.id}/location`, { headers: auth(data.submitToken), data: { latitude: 31, longitude: 121, accuracy: 10, timestamp: Date.now(), consent: true, submissionId: 'b'.repeat(32) } });
  await page.goto(link(data, 'view'));
  await expect(page.locator('#position-map')).toHaveAttribute('data-basemap', 'fallback');
  await expect(page.locator('#position-map path.leaflet-interactive')).toHaveCount(2);
  await expect(page.locator('#map-style')).toBeDisabled();
  await expect(page.locator('#position-precision')).toContainText('10 米');
  await expect(page.locator('#map-note')).toContainText('基础地图');
});

test('forged links cannot overwrite a valid cached view permission in the same tab', async ({ page, request }) => {
  const data = await create(request);
  await page.goto(link(data, 'view'));
  await expect(page.locator('#view-status')).toHaveText('等待对方分享');
  await page.goto(`/#view/${data.id}/${'f'.repeat(64)}`);
  await expect(page.getByRole('heading', { name: '这个链接暂时无法使用' })).toBeVisible();
  await page.goto(`/#view/${data.id}`);
  await expect(page.locator('#view-status')).toHaveText('等待对方分享');
});

test('static pages keep security headers when bypassing the Worker', async ({ request }) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(response.headers()['cache-control']).toContain('no-cache');
});

test('valid polar coordinates do not crash the Web Mercator map or hide the received location', async ({ page, request }) => {
  const data = await create(request);
  const response = await request.post(`/api/requests/${data.id}/location`, { headers: auth(data.submitToken), data: { latitude: 90, longitude: 0, accuracy: 10, timestamp: Date.now(), consent: true, submissionId: 'c'.repeat(32) } });
  expect(response.status()).toBe(200);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(link(data, 'view'));
  await expect(page.locator('#position-map')).toHaveAttribute('data-basemap', 'unsupported');
  await expect(page.locator('#position-map')).toContainText('超出网页地图的显示范围');
  await expect(page.locator('#latitude')).toHaveText('90.000000');
  await expect(page.locator('#google-link')).toHaveAttribute('href', /query=90%2C0/);
  expect(errors).toEqual([]);
});
