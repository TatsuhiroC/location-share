const app = document.querySelector('#app');
const API_ERRORS = {
  NOT_FOUND: '这个链接已失效、已删除，或地址不完整。', EXPIRED: '这个链接已过期，应用记录已删除。',
  UNAUTHORIZED: '链接的访问权限不正确，请重新打开完整的原始链接。',
  CREATOR_REQUIRED: '创建权限未验证，请使用你的专属管理入口或正确的创建口令。',
  CREATOR_NOT_CONFIGURED: '管理员尚未启用创建功能，请稍后再试。',
  ALREADY_RECEIVED: '这个链接已经收到一次位置，无法再次提交。',
  INVALID_LOCATION: '定位结果不完整或已超过五分钟，请重新获取位置。',
  RATE_LIMITED: '请求较多，已达到服务的访问额度，请稍后再试。',
  INVALID_REQUEST: '请检查填写内容和链接。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  ORIGIN_DENIED: '请直接在浏览器中打开本站。'
};
let dispose = () => {};
let navigation = 0;

const hex = length => [...crypto.getRandomValues(new Uint8Array(length))].map(n => n.toString(16).padStart(2, '0')).join('');
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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
function creatorKey() { try { return sessionStorage.getItem('creator-key') || ''; } catch { return ''; } }
let currentCreator = creatorKey();
function keepCreator(key) { currentCreator = key; try { sessionStorage.setItem('creator-key', key); } catch { /* In-memory access remains available. */ } }

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
  shell(`<div class="home-layout"><section class="intro"><div class="eyebrow">A LITTLE CLOSER</div><h1>告诉我，<br><span class="accent">你在这里。</span></h1><p class="lead">把一个链接发给对方。经对方同意，<br>收下一次当前位置，让见面更简单。</p>
    <div class="steps"><div class="step"><span>01 / CREATE</span><strong>创建链接</strong></div><div class="arrow">→</div><div class="step"><span>02 / ALLOW</span><strong>对方允许</strong></div><div class="arrow">→</div><div class="step"><span>03 / RECEIVE</span><strong>收到位置</strong></div></div>
    <p class="small-note">无需安装应用。只分享一次位置，记录自动过期。你可以稍后打开专属查看链接。</p></section>
    <section class="card"><div class="card-top">NEW LOCATION REQUEST <span class="pill">v0.2</span></div><h2>创建一次位置请求</h2><p class="card-sub">让对方知道位置将发给谁、用来做什么。</p>
    <form id="create-form"><div id="creator-field" class="field"><label for="creator-key">创建口令 <span class="hint">仅管理员可以创建</span></label><input id="creator-key" type="password" autocomplete="off" spellcheck="false" placeholder="输入你的专属创建口令" maxlength="64"></div>
    <p id="creator-ready" class="privacy-copy" hidden>已启用专属创建权限。<button id="copy-admin-link" class="cancel-button" type="button">复制管理入口</button> <button id="forget-creator" class="cancel-button" type="button">退出</button></p><div id="admin-note" role="status" class="message" hidden></div>
    <div class="field"><label for="recipient">接收人 <span class="hint">对方会看到这个名字</span></label><input id="recipient" name="recipient" required maxlength="60" autocomplete="name" placeholder="例如：小陈"></div>
    <div class="field"><label for="purpose">分享用途</label><textarea id="purpose" name="purpose" required maxlength="160" placeholder="例如：我们在公园碰面，方便找到你。"></textarea></div>
    <div class="field"><label for="hours">链接有效期</label><select id="hours" name="hours"><option value="24">24 小时</option><option value="1">1 小时</option></select></div>
    <div id="create-error" role="alert" hidden></div><button id="create-button" class="primary full" type="submit">创建分享链接 <span aria-hidden="true">↗</span></button>
    <p class="form-foot">创建链接不会获取你自己的位置。</p></form></section></div>`);
  el('creator-field').hidden = !!currentCreator; el('creator-ready').hidden = !currentCreator;
  el('copy-admin-link').onclick = () => copy(`${location.origin}/#admin/${currentCreator}`, 'admin-note');
  el('forget-creator').onclick = () => { currentCreator = ''; try { sessionStorage.removeItem('creator-key'); } catch {} home(); };
  el('create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = el('create-button');
    if (button.disabled) return;
    button.disabled = true; button.textContent = '正在创建…'; message('create-error', '');
    const version = navigation;
    const key = currentCreator || el('creator-key').value.trim();
    if (!/^[a-f0-9]{64}$/.test(key)) { message('create-error', '请使用你的专属管理入口，或输入完整的创建口令。', true); button.disabled = false; button.textContent = '创建分享链接 ↗'; return; }
    const recipient = el('recipient').value.trim(), purpose = el('purpose').value.trim(), hours = Number(el('hours').value);
    try {
      const result = await api('/requests', { method: 'POST', token: key, body: { recipient, purpose, hours } });
      if (navigation !== version) return;
      keepCreator(key);
      savePermission('view', result.id, result.viewToken);
      created(result, recipient, purpose);
    } catch (error) {
      if (navigation !== version) return;
      message('create-error', error.message, true); button.disabled = false; button.textContent = '创建分享链接 ↗';
    }
  });
}

function created(data, recipient, purpose) {
  const share = sharingUrl('share', data.id, data.submitToken), view = sharingUrl('view', data.id, data.viewToken);
  shell(`<section class="page-heading"><div class="eyebrow">READY TO SHARE</div><h1>链接准备好了</h1><p>把分享链接发给对方，把查看链接留给自己。</p></section><section class="card center-card">
    <dl class="metadata"><dt>接收人</dt><dd id="created-recipient"></dd><dt>分享用途</dt><dd id="created-purpose"></dd><dt>过期时间</dt><dd id="created-expiry"></dd></dl>
    <div class="link-box"><div class="link-heading">① 发给对方 <span class="pill">分享链接</span></div><input id="share-url" class="link-input" readonly aria-label="发给对方的分享链接"><div class="button-row"><button id="copy-share" class="primary">复制分享链接</button><button id="native-share" class="secondary" hidden>分享…</button></div><div id="share-message" role="status" class="message"></div></div>
    <div class="link-box owner-box"><div class="link-heading">② 留给自己 <span class="pill">专属查看</span></div><input id="view-url" class="link-input" readonly aria-label="自己的专属查看链接"><div class="button-row"><button id="copy-view" class="secondary">复制查看链接</button><a id="open-view" class="secondary">查看位置 ↗</a></div><div id="view-message" role="status" class="message"></div><p class="privacy-copy">持有这个链接的人可以查看位置和删除请求，请妥善保存。关闭本页后，请用保存的链接再次打开。</p></div>
    <p class="privacy-copy">对方允许定位后自动发送一次。记录会在过期时从应用中删除；你也可以提前删除。</p><a class="back-link" href="/">再创建一个请求</a></section>`);
  text('created-recipient', recipient); text('created-purpose', purpose); text('created-expiry', date(data.expiresAt));
  el('share-url').value = share; el('view-url').value = view; el('open-view').href = view;
  el('copy-share').onclick = () => copy(share, 'share-message', 'share-url');
  el('copy-view').onclick = () => copy(view, 'view-message', 'view-url');
  if (navigator.share) {
    el('native-share').hidden = false;
    el('native-share').onclick = async () => {
      try { await navigator.share({ title: '分享一次当前位置', text: `${recipient} 邀请你分享一次当前位置：${purpose}`, url: share }); }
      catch (error) { if (error.name !== 'AbortError') message('share-message', '分享未完成，可以复制链接发送。'); }
    };
  }
}

async function sharePage(id, token, version) {
  const info = await api(`/requests/${id}/info`, { token });
  if (navigation !== version) return;
  if (info.status === 'received') {
    shell(`<section class="page-heading"><div class="eyebrow">ONCE IS ENOUGH</div><h1>这个链接已经使用过</h1></section><section class="card center-card center"><div class="status-orbit"><span>✓</span></div><p class="status-copy">位置已分享过一次，无需重复发送。</p><a class="secondary" href="/">回到首页</a></section>`); return;
  }
  let operation = 0, pending = null, terminal = false;
  dispose = () => { operation++; pending = null; };
  shell(`<section class="page-heading"><div class="eyebrow">YOUR LOCATION, YOUR CHOICE</div><h1>分享一次当前位置</h1><p>允许后，当前位置会自动发送给以下接收人。</p></section><section class="card center-card">
    <dl class="metadata"><dt>接收人</dt><dd id="share-recipient"></dd><dt>分享用途</dt><dd id="share-purpose"></dd><dt>过期时间</dt><dd id="share-expiry"></dd></dl>
    <p class="privacy-copy">接收人和用途由链接发起人填写，请确认与你认识的人一致。</p><div class="consent-text">将发送经纬度、定位精度和获取时间。只发送一次；记录在链接过期时从应用中删除，接收人也可以提前删除。</div>
    <div id="share-feedback" role="status" class="message"></div><div id="share-error" role="alert" hidden></div>
    <button id="allow-share" class="primary full">同意并分享当前位置 ↗</button>
    <div class="center"><button id="cancel-location" class="cancel-button" hidden>取消获取位置</button></div>
    <p id="share-foot" class="form-foot">接下来浏览器会请求定位权限，请按你的意愿选择。</p><a class="back-link" href="/">暂不分享，返回首页</a></section>`);
  text('share-recipient', info.recipient); text('share-purpose', info.purpose); text('share-expiry', date(info.expiresAt));

  const reset = () => { el('allow-share').disabled = false; el('allow-share').textContent = pending ? '重试发送这次位置' : '同意并分享当前位置 ↗'; el('cancel-location').hidden = true; };
  async function send(current) {
    el('cancel-location').hidden = true;
    el('allow-share').textContent = '正在发送…'; message('share-feedback', '已获取位置，正在等待接收服务确认。');
    try {
      await api(`/requests/${id}/location`, { method: 'POST', token, body: pending });
      if (navigation !== version || operation !== current) return;
      pending = null; terminal = true;
      shell(`<section class="page-heading"><div class="eyebrow">LOCATION DELIVERED</div><h1>位置已发送</h1></section><section class="card center-card center"><div class="status-orbit"><span>✓</span></div><h2 class="status-title">现在，更容易找到你了</h2><p class="status-copy">本次位置已发送给 <strong id="success-recipient"></strong>。<br>你可以关闭这个页面。</p><p class="privacy-copy">只分享了这一次位置，不会继续获取。</p><a class="secondary" href="/">回到首页</a></section>`);
      text('success-recipient', info.recipient);
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
  el('allow-share').onclick = () => {
    if (terminal || el('allow-share').disabled) return;
    message('share-error', '');
    if (Date.now() >= info.expiresAt) { message('share-error', '链接已过期，请联系发起人创建新链接。', true); return; }
    if (!window.isSecureContext || !navigator.geolocation) { message('share-error', '当前浏览器无法定位，请使用 HTTPS 地址在 Safari 或 Chrome 中打开。', true); return; }
    const current = ++operation;
    el('allow-share').disabled = true;
    if (pending && Date.now() - pending.timestamp < 5 * 60 * 1000) { void send(current); return; }
    pending = null;
    el('allow-share').textContent = '正在获取位置…'; el('cancel-location').hidden = false;
    message('share-feedback', '请在浏览器提示中允许定位，并保持本页打开。');
    navigator.geolocation.getCurrentPosition(position => {
      if (navigation !== version || operation !== current) return;
      pending = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: positionTime(position.timestamp), consent: true, submissionId: hex(16) };
      void send(current);
    }, error => {
      if (navigation !== version || operation !== current) return;
      const reasons = { 1: '定位权限未允许，没有发送位置。如需分享，请在浏览器与系统设置中允许定位。', 2: '暂时获取不到位置，请检查系统定位服务，或移到信号更好的地方重试。', 3: '获取位置超时，请保持本页打开后重试。' };
      message('share-feedback', ''); message('share-error', reasons[error.code] || '获取位置失败，请重试。', true); reset();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };
}

async function viewPage(id, token, version) {
  let timer = null, busy = false, ended = false;
  let latest = null;
  const privateLink = sharingUrl('view', id, token);
  dispose = () => { ended = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  shell(`<section class="page-heading"><div class="eyebrow">JUST FOR YOU</div><h1>你的专属查看页</h1><p>位置到达后会显示在这里，你也可以稍后回来查看。</p></section><section class="card center-card">
    <div id="view-status" class="status-label">正在读取请求</div><dl class="metadata"><dt>接收人</dt><dd id="view-recipient">—</dd><dt>分享用途</dt><dd id="view-purpose">—</dd><dt>过期时间</dt><dd id="view-expiry">—</dd></dl>
    <div id="waiting-panel" class="center"><div class="status-orbit busy"><span>◎</span></div><h2 class="status-title">等待一次位置分享</h2><p class="status-copy">对方打开链接并允许后，<br>位置会出现在这里。</p></div>
    <section id="position-panel" hidden><dl class="data-grid"><div class="data-tile"><dt>纬度</dt><dd id="latitude"></dd></div><div class="data-tile"><dt>经度</dt><dd id="longitude"></dd></div><div class="data-tile"><dt>定位精度半径</dt><dd id="accuracy"></dd></div><div class="data-tile"><dt>位置获取于</dt><dd id="position-age"></dd></div><div class="data-tile wide"><dt>获取时间 · 访问设备的当地时间</dt><dd id="position-time"></dd></div></dl>
    <div class="map-links"><a id="osm-link" class="primary" target="_blank" rel="noopener noreferrer">打开地图 ↗</a><a id="apple-link" class="secondary" target="_blank" rel="noopener noreferrer">Apple 地图 ↗</a></div><p class="privacy-copy">这是一次位置快照，不代表对方现在仍在这里。点击地图链接会把坐标交给对应地图服务。</p></section>
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
    text('view-recipient', data.recipient); text('view-purpose', data.purpose); text('view-expiry', date(data.expiresAt));
    text('view-status', data.position ? '已收到一次位置' : '等待对方分享');
    if (data.position) {
      el('waiting-panel').hidden = true; el('position-panel').hidden = false;
      const p = data.position;
      text('latitude', p.latitude.toFixed(6)); text('longitude', p.longitude.toFixed(6));
      text('accuracy', `约 ${Math.round(p.accuracy)} 米`); text('position-time', date(p.timestamp)); updateAge();
      el('osm-link').href = `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=16/${p.latitude}/${p.longitude}`;
      el('apple-link').href = `https://maps.apple.com/?ll=${p.latitude},${p.longitude}&q=${encodeURIComponent('分享的位置')}`;
    }
  }
  async function refresh() {
    if (busy || ended || document.hidden) return;
    clearTimeout(timer); busy = true; el('refresh-view').disabled = true;
    try {
      const data = await api(`/requests/${id}`, { token });
      if (navigation !== version || ended) return;
      display(data); message('view-error', '');
    } catch (error) {
      if (navigation !== version || ended) return;
      if (['NOT_FOUND', 'EXPIRED', 'UNAUTHORIZED'].includes(error.code)) { dispose(); fatal(error); return; }
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
      dispose();
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
  const admin = /^admin\/([a-f0-9]{64})$/.exec(fragment);
  if (admin) {
    keepCreator(admin[1]);
    if (creatorKey() === admin[1]) history.replaceState(null, '', location.pathname);
    home(); return;
  }
  const match = /^(share|view)\/([a-f0-9]{32})(?:\/([a-f0-9]{64}))?$/.exec(fragment);
  if (!match) { fatal(new Error('链接不完整，请重新打开原始链接。')); return; }
  const [, role, id, originalToken] = match;
  const token = originalToken || cachedPermission(role, id);
  if (!token) { fatal(new Error('请重新打开包含访问权限的完整原始链接。')); return; }
  if (originalToken) {
    savePermission(role, id, token);
    // Keep reload working when browser storage is unavailable.
    if (cachedPermission(role, id) === token) history.replaceState(null, '', `${location.pathname}#${role}/${id}`);
  }
  shell('<div class="loading" role="status">正在打开…</div>'); app.setAttribute('aria-busy', 'true');
  try { await (role === 'share' ? sharePage(id, token, version) : viewPage(id, token, version)); }
  catch (error) { if (navigation === version) fatal(error); }
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { dispose(); navigation++; });
window.addEventListener('pageshow', event => { if (event.persisted) void route(); });
void route();
