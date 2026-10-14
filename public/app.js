import qrcode from './vendor/qrcode.js';
import { mapLinks, showMap } from './maps.js';

const app = document.querySelector('#app');
const API_ERRORS = {
  NOT_FOUND: '这个链接已失效、已删除，或地址不完整。', EXPIRED: '这个链接已过期，应用记录已删除。',
  UNAUTHORIZED: '链接的访问权限不正确，请重新打开完整的原始链接。',
  ALREADY_RECEIVED: '这个链接已经收到一次位置，无法再次提交。',
  INVALID_LOCATION: '定位结果不完整或已超过五分钟，请重新获取位置。',
  REQUEST_TIMEOUT: '请求传输超时，请检查网络后重试。',
  RATE_LIMITED: '请求较多，已达到服务的访问额度，请稍后再试。',
  INVALID_REQUEST: '请检查填写内容和链接。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  ORIGIN_DENIED: '请直接在浏览器中打开本站。'
};
let dispose = () => {};
let navigation = 0;

const hex = length => [...crypto.getRandomValues(new Uint8Array(length))].map(n => n.toString(16).padStart(2, '0')).join('');
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
// A product warning threshold, not a test of the OS's precise-location permission.
const ACCURACY_WARNING_METERS = 100;
const accuracyRange = meters => meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 米`;
function positionTime(value) {
  const now = Date.now();
  // Some WebKit geolocation implementations return epoch microseconds.
  // Convert only when it yields a plausible fresh sample; never replace stale time with "now".
  if (typeof value === 'number' && value > now * 100 && value / 1000 >= now - 300000 && value / 1000 <= now + 60000) return value / 1000;
  return value;
}

function shell(content) { app.innerHTML = content; app.setAttribute('aria-busy', 'false'); }
function el(id) { return document.getElementById(id); }
function text(id, value) { const node = el(id); if (node) node.textContent = value; }
function message(id, value, isError = false) {
  const node = el(id);
  if (!node) return;
  node.textContent = value;
  node.className = isError ? 'error' : 'message';
  node.hidden = !value;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api${path}`, {
      method, cache: 'no-store', credentials: 'omit', signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(API_ERRORS[data.error] || '请求未完成，请稍后重试。');
      error.code = data.error; error.status = response.status; throw error;
    }
    return data;
  } catch (error) {
    if (error.code) throw error;
    throw new Error('连接未完成，请检查网络后重试。');
  } finally { clearTimeout(timeout); }
}

function sharingUrl(role, id, token) {
  return `${location.origin}/#${role}/${id}/${token}`;
}

function savePermission(role, id, token) {
  try { sessionStorage.setItem(`permission:${role}:${id}`, token); } catch { /* The full original link still works. */ }
}
function cachedPermission(role, id) {
  try { return sessionStorage.getItem(`permission:${role}:${id}`); } catch { return null; }
}
function rememberPermission(role, id, token) {
  savePermission(role, id, token);
  if (cachedPermission(role, id) === token) history.replaceState(null, '', `${location.pathname}#${role}/${id}`);
}
function forgetRequest(id) {
  for (const role of ['share', 'view']) { try { sessionStorage.removeItem(`permission:${role}:${id}`); } catch {} }
  if (activeShare?.id === id) activeShare = null;
}
async function copy(value, outputId, inputId) {
  try { await navigator.clipboard.writeText(value); message(outputId, '已复制。'); }
  catch {
    message(outputId, '请长按或使用复制快捷键复制选中的链接。');
    let input = el(inputId);
    if (!input && el(outputId)) {
      input = document.createElement('input'); input.readOnly = true;
      input.value = value; input.className = 'link-input'; input.setAttribute('aria-label', '手动复制链接');
      el(outputId).append(input);
    }
    if (input) { input.focus(); input.select(); }
  }
}

function fatal(error) {
  shell(`<section class="page-heading"><div class="eyebrow">LOCATION SHARE</div><h1>这个链接暂时无法使用</h1></section>
    <section class="card center-card center"><div class="status-orbit"><span>—</span></div><p id="fatal-message" class="status-copy"></p><a class="secondary" href="/">回到首页</a></section>`);
  text('fatal-message', error.message);
}

function home() {
  shell(`<div class="home-layout"><section class="intro"><div class="eyebrow">A LITTLE CLOSER</div><h1>告诉我，<br><span class="accent">你在这里。</span></h1><p class="lead">把链接或二维码发给对方。<br>对方允许后，在这里看到一次当前位置。</p>
    <div class="steps"><div class="step"><span>01 / CREATE</span><strong>生成链接</strong></div><div class="arrow">→</div><div class="step"><span>02 / ALLOW</span><strong>对方允许</strong></div><div class="arrow">→</div><div class="step"><span>03 / RECEIVE</span><strong>看到位置</strong></div></div>
    <p class="small-note">无需安装应用。链接 1 小时有效，只分享一次位置。</p></section>
    <section class="card"><div class="card-top">NEW LOCATION REQUEST <span class="pill">v0.4</span></div><h2>生成临时分享链接</h2><p class="card-sub">填个名字，方便对方知道是谁发起的。也可以留空。</p>
    <form id="create-form"><div class="field"><label for="initiator">分享发起人 <span class="hint">可选</span></label><input id="initiator" name="initiator" maxlength="60" autocomplete="name" placeholder="例如：小陈"></div>
    <div id="create-error" role="alert" hidden></div><button id="create-button" class="primary full" type="submit">生成临时链接 <span aria-hidden="true">↗</span></button>
    <p class="form-foot">生成链接不会获取你自己的位置。</p></form></section></div>`);
  el('create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = el('create-button');
    if (button.disabled) return;
    button.disabled = true; button.textContent = '正在生成…'; message('create-error', '');
    const version = navigation;
    try {
      const result = await api('/requests', { method: 'POST', body: { initiator: el('initiator').value.trim() } });
      if (navigation !== version) return;
      savePermission('share', result.id, result.submitToken);
      savePermission('view', result.id, result.viewToken);
      // Keep the new sender's share permission even when session storage is disabled.
      activeShare = { id: result.id, token: result.submitToken };
      location.hash = `view/${result.id}/${result.viewToken}`;
    } catch (error) {
      if (navigation !== version) return;
      message('create-error', error.message, true); button.disabled = false; button.textContent = '生成临时链接 ↗';
    }
  });
}

let activeShare = null;
function shareTools(id, token, initiator) {
  const share = sharingUrl('share', id, token);
  el('send-panel').hidden = false;
  el('share-url').value = share;
  const qr = qrcode(0, 'M'); qr.addData(share); qr.make();
  el('share-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  el('share-qr').setAttribute('role', 'img'); el('share-qr').setAttribute('aria-label', '对方扫码分享位置的二维码');
  el('copy-share').onclick = () => copy(share, 'share-message', 'share-url');
  if (navigator.share) {
    el('native-share').hidden = false;
    el('native-share').onclick = async () => {
      try { await navigator.share({ title: '分享一次当前位置', text: initiator ? `${initiator} 邀请你分享一次当前位置` : '邀请你分享一次当前位置', url: share }); }
      catch (error) { if (error.name !== 'AbortError') message('share-message', '分享未完成，可以复制链接发送。'); }
    };
  }
}

async function sharePage(id, token, version) {
  const info = await api(`/requests/${id}/info`, { token });
  if (navigation !== version) return;
  rememberPermission('share', id, token);
  if (info.status === 'received') {
    shell(`<section class="page-heading"><div class="eyebrow">ONCE IS ENOUGH</div><h1>这个链接已经使用过</h1></section><section class="card center-card center"><div class="status-orbit"><span>✓</span></div><p class="status-copy">位置已分享过一次，无需重复发送。</p><a class="secondary" href="/">回到首页</a></section>`); return;
  }
  let operation = 0, pending = null, terminal = false;
  dispose = () => { operation++; pending = null; el('accuracy-dialog')?.close(); };
  shell(`<section class="page-heading"><div class="eyebrow">YOUR LOCATION, YOUR CHOICE</div><h1>分享一次当前位置</h1><p id="share-invitation"></p></section><section class="card center-card">
    <dl class="metadata"><dt>发起人</dt><dd id="share-initiator"></dd><dt>过期时间</dt><dd id="share-expiry"></dd></dl>
    <p class="privacy-copy">发起人名称由对方填写，未经身份验证，请确认链接来源。</p><div class="consent-text">允许后，将向发起人发送一次当前位置、精度和时间，并通过基于 OpenStreetMap 的地图展示。记录在链接过期后删除。</div>
    <div id="share-feedback" role="status" class="message"></div><div id="share-error" role="alert" hidden></div>
    <button id="allow-share" class="primary full">允许分享当前位置 ↗</button>
    <div class="center"><button id="cancel-location" class="cancel-button" hidden>取消获取位置</button></div>
    <p id="share-foot" class="form-foot">接下来浏览器会请求定位权限。希望分享更准确的位置时，请选择“精确位置”。精度较低时会先询问你，不会直接发送。</p><a class="back-link" href="/">暂不分享，返回首页</a>
    <dialog id="accuracy-dialog" aria-labelledby="accuracy-title" aria-describedby="accuracy-estimate"><h2 id="accuracy-title">要获取更精确的位置吗？</h2><p id="accuracy-estimate"></p><p class="privacy-copy">这次位置还没有发送。精度较低可能是只允许了大致位置，也可能是定位信号不好。</p>
    <details class="precision-help"><summary>如何开启精确位置？</summary><p>iPhone：设置 → 隐私与安全性 → 定位服务 → 当前浏览器（Safari 可能显示为“Safari 网站”）→ 开启“精确位置”。</p><p>Android：设置 → 应用 → 当前浏览器 → 权限 → 位置信息 → 开启“使用精确位置”。不同手机的名称可能不同。</p><p>也请允许当前网站定位。返回本页后点击下面的“重新获取”；可以移到信号较好的地方。网页无法替你开启权限，也不能保证重新定位会更准确。</p></details>
    <button id="retry-precise" class="primary full">重新获取更精确的位置</button><button id="send-approximate" class="secondary full">仍发送当前大致位置</button><div class="center"><button id="cancel-approximate" class="cancel-button">暂不分享</button></div></dialog></section>`);
  text('share-invitation', info.initiator ? `${info.initiator} 邀请你分享位置。是否允许？` : '有人邀请你分享位置。是否允许？');
  text('share-initiator', info.initiator || '未填写'); text('share-expiry', date(info.expiresAt));

  const reset = () => { el('allow-share').disabled = false; el('allow-share').textContent = pending ? '重试发送这次位置' : '允许分享当前位置 ↗'; el('cancel-location').hidden = true; };
  async function send(current) {
    if (!pending || navigation !== version || operation !== current) return;
    if (Date.now() >= info.expiresAt || Date.now() - pending.timestamp >= 300000) {
      pending = null; message('share-feedback', '');
      message('share-error', Date.now() >= info.expiresAt ? '链接已过期，请联系发起人创建新链接。' : '定位结果已超过五分钟，请重新获取位置。', true); reset(); return;
    }
    el('cancel-location').hidden = true;
    el('allow-share').textContent = '正在发送…'; message('share-feedback', '已获取位置，正在等待接收服务确认。');
    try {
      await api(`/requests/${id}/location`, { method: 'POST', token, body: pending });
      if (navigation !== version || operation !== current) return;
      pending = null; terminal = true;
      shell(`<section class="page-heading"><div class="eyebrow">LOCATION DELIVERED</div><h1>位置已发送</h1></section><section class="card center-card center"><div class="status-orbit"><span>✓</span></div><h2 class="status-title">现在，更容易找到你了</h2><p class="status-copy">本次位置已发送给 <strong id="success-recipient"></strong>。<br>你可以关闭这个页面。</p><p class="privacy-copy">只分享了这一次位置，不会继续获取。</p><a class="secondary" href="/">回到首页</a></section>`);
      text('success-recipient', info.initiator || '本次链接的发起人');
    } catch (error) {
      if (navigation !== version || operation !== current) return;
      message('share-feedback', ''); message('share-error', error.message, true);
      if (['ALREADY_RECEIVED', 'NOT_FOUND', 'EXPIRED', 'UNAUTHORIZED'].includes(error.code)) { terminal = true; pending = null; el('allow-share').hidden = true; text('share-foot', '请联系发起人创建新的链接。'); }
      else {
        if (error.code === 'INVALID_LOCATION') pending = null;
        reset();
      }
    }
  }
  el('cancel-location').onclick = () => { operation++; pending = null; message('share-feedback', '已取消，没有发送位置。'); reset(); };
  const cancelApproximate = () => {
    el('accuracy-dialog').close(); operation++; pending = null;
    message('share-feedback', '已取消，没有发送位置。'); reset();
  };
  el('cancel-approximate').onclick = cancelApproximate;
  el('accuracy-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelApproximate(); });
  el('retry-precise').onclick = () => { el('accuracy-dialog').close(); pending = null; acquire(); };
  el('send-approximate').onclick = () => { el('accuracy-dialog').close(); void send(operation); };
  function acquire() {
    if (terminal) return;
    message('share-error', '');
    if (Date.now() >= info.expiresAt) { pending = null; message('share-feedback', ''); message('share-error', '链接已过期，请联系发起人创建新链接。', true); reset(); return; }
    if (!window.isSecureContext || !navigator.geolocation) { message('share-error', '当前浏览器无法定位，请使用 HTTPS 地址在 Safari 或 Chrome 中打开。', true); reset(); return; }
    const current = ++operation;
    el('allow-share').disabled = true;
    pending = null;
    el('allow-share').textContent = '正在获取位置…'; el('cancel-location').hidden = false;
    message('share-feedback', '请在浏览器提示中允许定位，并保持本页打开。');
    navigator.geolocation.getCurrentPosition(position => {
      if (navigation !== version || operation !== current) return;
      pending = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: positionTime(position.timestamp), consent: true, submissionId: hex(16) };
      if (pending.accuracy > ACCURACY_WARNING_METERS) {
        el('cancel-location').hidden = true; text('allow-share', '等待你确认…'); message('share-feedback', '');
        text('accuracy-estimate', `浏览器估算的精度半径约 ${accuracyRange(pending.accuracy)}，当前位置可能较模糊。是否希望提高精度后再发送？`);
        el('accuracy-dialog').showModal();
      } else { void send(current); }
    }, error => {
      if (navigation !== version || operation !== current) return;
      const reasons = { 1: '定位权限未允许，没有发送位置。如需分享，请在浏览器与系统设置中允许定位。', 2: '暂时获取不到位置，请检查系统定位服务，或移到信号更好的地方重试。', 3: '获取位置超时，请保持本页打开后重试。' };
      message('share-feedback', ''); message('share-error', reasons[error.code] || '获取位置失败，请重试。', true); reset();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }
  el('allow-share').onclick = () => {
    if (terminal || el('allow-share').disabled) return;
    message('share-error', '');
    // Only a previously confirmed upload can remain here after a lost receipt.
    if (pending && Date.now() - pending.timestamp < 300000) {
      el('allow-share').disabled = true; void send(++operation);
    } else { acquire(); }
  };
}

async function viewPage(id, token, version) {
  let timer = null, busy = false, ended = false;
  let latest = null, removeMap = () => {}, mapShown = false, toolsShown = false, remembered = false;
  const shareToken = activeShare?.id === id ? activeShare.token : cachedPermission('share', id);
  const privateLink = sharingUrl('view', id, token);
  dispose = () => { ended = true; clearTimeout(timer); removeMap(); document.removeEventListener('visibilitychange', visible); };
  shell(`<section class="page-heading"><div class="eyebrow">JUST FOR YOU</div><h1 id="view-title">链接准备好了</h1><p id="view-description">把链接或二维码发给对方，收到的位置会直接显示在本页。</p></section><section class="card center-card viewer-card">
    <div id="view-status" class="status-label">正在读取请求</div><dl class="metadata"><dt>发起人</dt><dd id="view-initiator">—</dd><dt>过期时间</dt><dd id="view-expiry">—</dd></dl>
    <section id="send-panel" class="link-box" hidden><div class="link-heading">发给对方 <span class="pill">链接 / 二维码</span></div><div id="share-qr" class="share-qr"></div><p class="qr-caption">对方扫码，或打开下面的链接</p><input id="share-url" class="link-input" readonly aria-label="发给对方的分享链接"><div class="button-row"><button id="copy-share" class="primary">复制分享链接</button><button id="native-share" class="secondary" hidden>分享…</button></div><div id="share-message" role="status" class="message"></div></section>
    <div id="waiting-panel" class="center"><h2 class="status-title">等待一次位置分享</h2><p class="status-copy">对方打开链接并允许后，<br>位置会出现在这里。</p></div>
    <section id="position-panel" hidden><p id="position-precision" class="notice" role="status"></p><div class="map-toolbar"><label for="map-style">地图风格</label><select id="map-style"><option value="positron">北欧浅色</option><option value="liberty">柔和街道</option><option value="dark">深色地图</option></select></div><div id="position-map" class="position-map" aria-label="分享位置的 OpenStreetMap 地图"></div><p id="map-note" class="privacy-copy" role="status" hidden></p>
    <h2 class="app-heading">通过其他 APP 打开</h2><div class="map-links"><a id="amap-link" class="secondary" target="_blank" rel="noopener noreferrer">高德地图 ↗</a><a id="baidu-link" class="secondary" target="_blank" rel="noopener noreferrer">百度地图 ↗</a><a id="google-link" class="secondary" target="_blank" rel="noopener noreferrer">Google 地图 ↗</a><a id="apple-link" class="secondary" target="_blank" rel="noopener noreferrer">苹果地图 ↗</a></div><details class="position-details"><summary>查看位置详情</summary><dl class="data-grid"><div class="data-tile"><dt>纬度</dt><dd id="latitude"></dd></div><div class="data-tile"><dt>经度</dt><dd id="longitude"></dd></div><div class="data-tile"><dt>定位精度半径</dt><dd id="accuracy"></dd></div><div class="data-tile"><dt>位置获取于</dt><dd id="position-age"></dd></div><div class="data-tile wide"><dt>获取时间 · 访问设备的当地时间</dt><dd id="position-time"></dd></div></dl></details><p id="app-fallback" class="privacy-copy" hidden>百度 APP 未打开？<a id="baidu-web" target="_blank" rel="noopener noreferrer">使用百度网页版地图</a></p><p class="privacy-copy">这是一次位置快照。地图数据来自 OpenStreetMap，底图由 OpenFreeMap 提供；选择 APP 后，坐标会交给对应地图服务。能否打开 APP 取决于设备和安装情况。</p></section>
    <div id="view-error" role="alert" hidden></div><div id="view-note" role="status" class="message"></div>
    <hr class="divider"><div class="button-row"><button id="refresh-view" class="secondary">刷新</button><button id="save-view-link" class="secondary">复制查看链接</button></div>
    <p class="privacy-copy">请保存查看链接；链接持有者可以查看和删除本次请求。页面后台暂停更新，回来后自动刷新。</p><button id="delete-request" class="danger full">删除请求与位置</button><a class="back-link" href="/">创建新请求</a>
    <dialog id="delete-dialog"><h2>删除这次请求？</h2><p>保存的位置会从应用中删除，分享链接和查看链接都会失效。</p><div class="button-row"><button id="cancel-delete" class="secondary">保留</button><button id="confirm-delete" class="danger">确认删除</button></div></dialog></section>`);
  function updateAge() {
    if (!latest?.position) return;
    const seconds = Math.max(0, Math.floor((Date.now() - latest.position.timestamp) / 1000));
    text('position-age', seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`);
  }
  function display(data) {
    latest = data;
    text('view-initiator', data.initiator || '未填写');
    if (shareToken && !toolsShown) { shareTools(id, shareToken, data.initiator); toolsShown = true; }
    if (!shareToken && !data.position) { text('view-title', '等待对方分享'); text('view-description', '对方允许后，位置会显示在这里。'); }
    text('view-expiry', date(data.expiresAt));
    text('view-status', data.position ? '已收到一次位置' : '等待对方分享');
    if (data.position) {
      el('waiting-panel').hidden = true; el('position-panel').hidden = false;
      const p = data.position;
      const approximate = p.accuracy > ACCURACY_WARNING_METERS;
      text('position-precision', approximate ? `本次定位精度较低：浏览器估算的精度半径约 ${accuracyRange(p.accuracy)}。地图上的点只是估算中心，请以圆形范围为参考。` : `浏览器估算的精度半径约 ${accuracyRange(p.accuracy)}。`);
      el('position-precision').className = approximate ? 'precision-warning' : 'notice';
      text('view-title', '已收到对方的位置'); text('view-description', '位置已显示在地图上。'); el('send-panel').hidden = true;
      text('latitude', p.latitude.toFixed(6)); text('longitude', p.longitude.toFixed(6));
      text('accuracy', `约 ${Math.round(p.accuracy)} 米`); text('position-time', date(p.timestamp)); updateAge();
      const links = mapLinks(p);
      for (const name of ['amap', 'baidu', 'google', 'apple']) el(`${name}-link`).href = links[name];
      el('baidu-web').href = links.baiduWeb;
      el('baidu-link').onclick = () => { el('app-fallback').hidden = false; };
      if (!mapShown) { removeMap = showMap(p); mapShown = true; }
    }
  }
  async function refresh() {
    if (busy || ended || document.hidden) return;
    clearTimeout(timer); busy = true; el('refresh-view').disabled = true;
    try {
      const data = await api(`/requests/${id}`, { token });
      if (navigation !== version || ended) return;
      if (!remembered) { rememberPermission('view', id, token); remembered = true; }
      display(data); message('view-error', '');
    } catch (error) {
      if (navigation !== version || ended) return;
      if (['NOT_FOUND', 'EXPIRED', 'UNAUTHORIZED'].includes(error.code)) {
        if (error.code !== 'UNAUTHORIZED') forgetRequest(id);
        dispose(); fatal(error); return;
      }
      message('view-error', error.message, true);
    } finally {
      busy = false;
      if (navigation === version && !ended) {
        el('refresh-view').disabled = false;
        timer = setTimeout(refresh, latest?.position ? 30000 : 5000);
      }
    }
  }
  function visible() { if (document.hidden) clearTimeout(timer); else { updateAge(); void refresh(); } }
  document.addEventListener('visibilitychange', visible);
  el('refresh-view').onclick = () => { updateAge(); void refresh(); };
  el('save-view-link').onclick = () => copy(privateLink, 'view-note');
  el('delete-request').onclick = () => el('delete-dialog').showModal();
  el('cancel-delete').onclick = () => el('delete-dialog').close();
  el('confirm-delete').onclick = async () => {
    el('confirm-delete').disabled = true;
    try {
      await api(`/requests/${id}`, { method: 'DELETE', token });
      if (navigation !== version) return;
      dispose(); forgetRequest(id);
      shell(`<section class="page-heading"><div class="eyebrow">ALL DONE</div><h1>请求已删除</h1></section><section class="card center-card center"><p class="status-copy">应用中的位置记录已删除，所有链接已失效。</p><a class="primary" href="/">创建新请求</a></section>`);
    } catch (error) {
      if (navigation !== version || ended) return;
      el('delete-dialog').close(); message('view-error', error.message, true); el('confirm-delete').disabled = false;
    }
  };
  await refresh();
}

async function route() {
  dispose(); dispose = () => {};
  const version = ++navigation;
  const fragment = location.hash.slice(1);
  if (!fragment) { home(); return; }
  const match = /^(share|view)\/([a-f0-9]{32})(?:\/((?:s)?[a-f0-9]{64}))?$/.exec(fragment);
  if (!match) { fatal(new Error('链接不完整，请重新打开原始链接。')); return; }
  const [, role, id, originalToken] = match;
  const token = originalToken || cachedPermission(role, id);
  if (!token) { fatal(new Error('请重新打开包含访问权限的完整原始链接。')); return; }
  shell('<div class="loading" role="status">正在打开…</div>'); app.setAttribute('aria-busy', 'true');
  try { await (role === 'share' ? sharePage(id, token, version) : viewPage(id, token, version)); }
  catch (error) {
    if (navigation !== version) return;
    if (['NOT_FOUND', 'EXPIRED'].includes(error.code)) forgetRequest(id);
    fatal(error);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { dispose(); navigation++; });
window.addEventListener('pageshow', event => { if (event.persisted) void route(); });
void route();
