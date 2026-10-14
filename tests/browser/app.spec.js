import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';

async function create(request, extra = {}) {
  const response = await request.post('/api/requests', {
    headers: { Authorization: `Bearer ${'e'.repeat(64)}`, 'CF-Connecting-IP': `test-${randomBytes(8).toString('hex')}` },
    data: { recipient: '小陈', purpose: '公园碰面', hours: 24, ...extra }
  });
  expect(response.status()).toBe(201);
  return response.json();
}
const auth = token => ({ Authorization: `Bearer ${token}` });
const link = (data, role) => `/#${role}/${data.id}/${role === 'view' ? data.viewToken : data.submitToken}`;

test('create, explicit consent, real browser geolocation, receipt, refresh, deletion', async ({ browser, baseURL }) => {
  const owner = await browser.newContext({ baseURL });
  const sharer = await browser.newContext({ baseURL, permissions: ['geolocation'], geolocation: { latitude: 31.2304, longitude: 121.4737, accuracy: 12 } });
  const ownerPage = await owner.newPage();
  await ownerPage.goto('/');
  await ownerPage.getByLabel('创建口令', { exact: false }).fill('e'.repeat(64));
  await ownerPage.getByLabel('接收人', { exact: false }).fill('小陈');
  await ownerPage.getByLabel('分享用途', { exact: true }).fill('公园碰面');
  await ownerPage.getByRole('button', { name: '创建分享链接' }).click();
  await expect(ownerPage.getByRole('heading', { name: '链接准备好了' })).toBeVisible();
  const shareUrl = await ownerPage.getByLabel('发给对方的分享链接').inputValue();
  const viewUrl = await ownerPage.getByLabel('自己的专属查看链接').inputValue();
  expect(shareUrl).not.toEqual(viewUrl);
  await ownerPage.goto(viewUrl);
  await expect(ownerPage.getByText('等待一次位置分享')).toBeVisible();
  const sharePage = await sharer.newPage();
  let submissions = 0;
  sharePage.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/location')) submissions++; });
  await sharePage.goto(shareUrl);
  await expect(sharePage.getByRole('button', { name: '同意并分享当前位置' })).toBeVisible();
  expect(submissions).toBe(0);
  await sharePage.getByRole('button', { name: '同意并分享当前位置' }).click();
  await expect(sharePage.getByRole('heading', { name: '位置已发送' })).toBeVisible();
  expect(submissions).toBe(1);
  await ownerPage.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(ownerPage.locator('#latitude')).toHaveText('31.230400');
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
  await page.getByRole('button', { name: '同意并分享当前位置' }).click();
  await expect(page.getByRole('alert')).toContainText('定位权限未允许，没有发送位置');
  const response = await request.get(`/api/requests/${data.id}`, { headers: auth(data.viewToken) });
  expect((await response.json()).position).toBeNull();
});

test('cancelled geolocation callback cannot later send a position', async ({ page, request }) => {
  const data = await create(request);
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = ok => { window.delayedFix = ok; }; });
  await page.goto(link(data, 'share'));
  await page.getByRole('button', { name: '同意并分享当前位置' }).click();
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
  await page.getByRole('button', { name: '同意并分享当前位置' }).click();
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
  const data = await create(request, { recipient: '<img src=x onerror=alert(1)>', purpose: '<script>alert(1)</script>' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(link(data, 'share'));
  await expect(page.locator('#share-recipient')).toHaveText('<img src=x onerror=alert(1)>');
  expect(await page.locator('#share-recipient img').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '创建一次位置请求' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('creation limit enforces five requests per minute per client', async ({ request }) => {
  const client = `limit-${randomBytes(8).toString('hex')}`;
  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/requests', { headers: { ...auth('e'.repeat(64)), 'CF-Connecting-IP': client }, data: { recipient: '小陈', purpose: '碰面', hours: 1 } });
    expect(response.status()).toBe(i < 5 ? 201 : 429);
  }
});

test('unauthorized and invalid creation attempts cannot exhaust valid creation quota', async ({ request }) => {
  const client = `failed-${randomBytes(8).toString('hex')}`;
  const data = { recipient: '小陈', purpose: '碰面', hours: 1 };
  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/requests', { headers: { ...auth('f'.repeat(64)), 'CF-Connecting-IP': client }, data });
    expect(response.status()).toBe(401);
  }
  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/requests', { headers: { ...auth('e'.repeat(64)), 'CF-Connecting-IP': client }, data: { ...data, recipient: '' } });
    expect(response.status()).toBe(400);
  }
  expect((await request.post('/api/requests', { headers: { ...auth('e'.repeat(64)), 'CF-Connecting-IP': client }, data })).status()).toBe(201);
});

test('private admin entry enables creation; normal visitors cannot create', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('创建口令', { exact: false })).toBeVisible();
  await page.goto(`/#admin/${'e'.repeat(64)}`);
  await expect(page.locator('#creator-ready')).toBeVisible();
  await expect(page.getByLabel('创建口令', { exact: false })).toBeHidden();
  expect(page.url()).not.toContain('e'.repeat(64));
  await page.reload();
  await expect(page.locator('#creator-ready')).toBeVisible();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByLabel('创建口令', { exact: false })).toBeVisible();
});
