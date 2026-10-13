const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => new Date(d).toLocaleString();

let token = '';
try { token = localStorage.getItem('wa_token') || ''; } catch {}
let currentTab = 'dashboard';
let pollTimer = null;

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: form || (body && JSON.stringify(body)) });
  if (res.status === 401 && !path.startsWith('/auth')) { showLogin(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- Auth ---------- */
function showLogin() {
  token = '';
  try { localStorage.removeItem('wa_token'); } catch {}
  clearInterval(pollTimer);
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  switchTab(currentTab);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(currentTab), 3000);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { token: t } = await api('/auth/login', { method: 'POST', body: Object.fromEntries(f) });
    token = t;
    try { localStorage.setItem('wa_token', t); } catch {}
    $('#login-error').textContent = '';
    showApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------- Tabs ---------- */
$$('.sidebar a[data-tab]').forEach((a) => a.addEventListener('click', () => switchTab(a.dataset.tab)));
function switchTab(tab) {
  currentTab = tab;
  $$('.sidebar a[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  refresh(tab);
}
async function refresh(tab) {
  try {
    if (tab === 'dashboard') await loadStats();
    if (tab === 'sessions') await loadSessions();
    if (tab === 'send' || tab === 'campaigns') await loadSessionSelects();
    if (tab === 'contacts' && !$('#contact-search').matches(':focus')) await loadContacts();
    if (tab === 'campaigns') await loadCampaigns();
    if (tab === 'logs') await loadLogs();
    if (tab === 'keys') await loadKeys();
    if (tab === 'docs') renderDocs();
  } catch (e) { console.warn(e.message); }
}

/* ---------- Dashboard ---------- */
async function loadStats() {
  const s = await api('/stats');
  const items = [
    ['Connected numbers', `${s.connected}/${s.sessions}`], ['Contacts', s.contacts], ['Opted out', s.optedOut],
    ['Campaigns', s.campaigns], ['Sent today', s.sentToday], ['Failed today', s.failedToday], ['Received today', s.receivedToday],
  ];
  $('#stats').innerHTML = items.map(([l, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join('');
}

/* ---------- Sessions ---------- */
$('#session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/sessions', { method: 'POST', body: { id: e.target.id.value.trim() } });
    e.target.reset();
    loadSessions();
  } catch (err) { alert(err.message); }
});
async function loadSessions() {
  const list = await api('/sessions');
  const detailed = await Promise.all(list.map((s) => api(`/sessions/${encodeURIComponent(s.id)}`)));
  $('#sessions').innerHTML = detailed.length ? detailed.map((s) => `
    <div class="card session">
      <h3>${esc(s.id)}</h3>
      <span class="badge ${esc(s.status)}">${esc(s.status)}</span>
      ${s.user ? `<p>${esc(s.user.name || '')}<br><span class="muted">+${esc((s.user.id || '').split(/[:@]/)[0])}</span></p>` : ''}
      ${s.qr ? `<p><img src="${s.qr}" alt="QR code"></p><p class="muted">Scan with WhatsApp → Linked devices</p>` : ''}
      ${s.status === 'starting' ? '<p class="muted">Generating QR…</p>' : ''}
      <div class="row" style="justify-content:center">
        ${['disconnected', 'logged_out'].includes(s.status) ? `<button class="btn sm" data-reconnect="${esc(s.id)}">Reconnect</button>` : ''}
        <button class="btn sm danger" data-logout="${esc(s.id)}">Unlink</button>
      </div>
    </div>`).join('') : '<p class="muted">No numbers yet. Add one above.</p>';
}
$('#sessions').addEventListener('click', async (e) => {
  const re = e.target.dataset.reconnect, lo = e.target.dataset.logout;
  try {
    if (re) await api('/sessions', { method: 'POST', body: { id: re } });
    if (lo && confirm(`Unlink "${lo}" from WhatsApp?`)) await api(`/sessions/${encodeURIComponent(lo)}?logout=true`, { method: 'DELETE' });
    loadSessions();
  } catch (err) { alert(err.message); }
});
async function loadSessionSelects() {
  const list = (await api('/sessions')).filter((s) => s.status === 'connected');
  $$('.session-select').forEach((sel) => {
    const cur = sel.value;
    const html = list.length
      ? list.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} ${s.user ? '(+' + esc(s.user.id.split(/[:@]/)[0]) + ')' : ''}</option>`).join('')
      : '<option value="">No connected numbers</option>';
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; if (cur) sel.value = cur; }
  });
}

/* ---------- Send ---------- */
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('#send-result');
  out.textContent = 'Sending…';
  try {
    const file = f.file.files[0];
    if (file) {
      const fd = new FormData();
      fd.append('sessionId', f.sessionId.value); fd.append('to', f.to.value); fd.append('caption', f.text.value); fd.append('file', file);
      await api('/messages/media', { method: 'POST', form: fd });
    } else {
      if (!f.text.value.trim()) throw new Error('Enter a message or attach a file');
      await api('/messages/text', { method: 'POST', body: { sessionId: f.sessionId.value, to: f.to.value, text: f.text.value } });
    }
    out.innerHTML = '<span class="badge sent">Sent</span>';
    f.text.value = ''; f.file.value = '';
  } catch (err) { out.innerHTML = `<span class="error">${esc(err.message)}</span>`; }
});

/* ---------- Contacts ---------- */
$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/contacts', { method: 'POST', body: { phone: f.phone.value, name: f.name.value, tags: f.tags.value.split(',') } });
    f.reset(); loadContacts();
  } catch (err) { alert(err.message); }
});
$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/contacts/import', { method: 'POST', form: new FormData(e.target) });
    $('#import-result').textContent = `Imported ${r.imported}, skipped ${r.skipped}`;
    e.target.reset(); loadContacts();
  } catch (err) { $('#import-result').textContent = err.message; }
});
let searchTimer;
$('#contact-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadContacts, 250); });
async function loadContacts() {
  const q = $('#contact-search').value.trim();
  const list = await api(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#contacts').innerHTML = list.slice(0, 500).map((c) => `
    <tr><td>+${esc(c.phone)}</td><td>${esc(c.name)}</td><td>${(c.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</td>
    <td>${c.optedOut ? '<span class="badge opted">opted out</span>' : '<span class="badge sent">active</span>'}</td>
    <td><button class="btn sm" data-toggle="${c.id}" data-opt="${c.optedOut ? 1 : 0}">${c.optedOut ? 'Re-subscribe' : 'Opt out'}</button>
        <button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`).join('') ||
    '<tr><td colspan="5" class="muted">No contacts</td></tr>';
}
$('#contacts').addEventListener('click', async (e) => {
  const { toggle, opt, del } = e.target.dataset;
  if (toggle) await api(`/contacts/${toggle}`, { method: 'PATCH', body: { optedOut: opt !== '1' } });
  if (del && confirm('Delete contact?')) await api(`/contacts/${del}`, { method: 'DELETE' });
  loadContacts();
});

/* ---------- Campaigns ---------- */
$('#campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const c = await api('/campaigns', { method: 'POST', body: {
      name: f.name.value, sessionId: f.sessionId.value, tags: f.tags.value, message: f.message.value,
      mediaUrl: f.mediaUrl.value || null, startNow: f.startNow.checked,
    } });
    alert(`Campaign created for ${c.stats.total} recipients`);
    f.reset(); loadCampaigns();
  } catch (err) { alert(err.message); }
});
async function loadCampaigns() {
  const list = await api('/campaigns');
  $('#campaigns').innerHTML = list.map((c) => {
    const done = c.stats.sent + c.stats.failed + c.stats.skipped;
    const pct = c.stats.total ? Math.round((done / c.stats.total) * 100) : 0;
    return `<tr><td>${esc(c.name)}<br><span class="muted">${fmt(c.createdAt)}</span></td><td>${esc(c.sessionId)}</td>
      <td><span class="badge ${esc(c.status)}">${esc(c.status.replace('_', ' '))}</span></td>
      <td>${c.stats.sent} sent · ${c.stats.failed} failed · ${c.stats.skipped} skipped / ${c.stats.total}
        <div class="progress"><div style="width:${pct}%"></div></div></td>
      <td>${c.status === 'running'
        ? `<button class="btn sm" data-pause="${c.id}">Pause</button>`
        : c.status !== 'completed' ? `<button class="btn sm" data-start="${c.id}">${c.status === 'draft' ? 'Start' : 'Resume'}</button>` : ''}
        <button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">No campaigns</td></tr>';
}
$('#campaigns').addEventListener('click', async (e) => {
  const { start, pause, del } = e.target.dataset;
  try {
    if (start) await api(`/campaigns/${start}/start`, { method: 'POST' });
    if (pause) await api(`/campaigns/${pause}/pause`, { method: 'POST' });
    if (del && confirm('Delete campaign?')) await api(`/campaigns/${del}`, { method: 'DELETE' });
    loadCampaigns();
  } catch (err) { alert(err.message); }
});

/* ---------- Logs ---------- */
// Keep a <select>'s options in sync without losing the current choice.
function fillSelect(sel, firstLabel, items) {
  const html = `<option value="">${firstLabel}</option>` +
    items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (sel.dataset.html === html) return;
  const cur = sel.value;
  sel.innerHTML = html;
  sel.dataset.html = html;
  sel.value = cur;
}

function logQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('#log-filters'))) {
    if (!v) continue;
    // date inputs are local days; send exact start/end instants
    if (k === 'from') p.set(k, new Date(`${v}T00:00:00`).toISOString());
    else if (k === 'to') p.set(k, new Date(`${v}T23:59:59.999`).toISOString());
    else p.set(k, v);
  }
  return p.toString();
}

async function loadLogs() {
  const f = $('#log-filters');
  const [sessions, campaigns] = await Promise.all([api('/sessions'), api('/campaigns')]);
  fillSelect(f.sessionId, 'All numbers', sessions.map((s) => [s.id, s.id]));
  fillSelect(f.campaignId, 'All messages', campaigns.map((c) => [c.id, `Campaign: ${c.name}`]));

  const { total, messages: list } = await api(`/messages?${logQuery()}`);
  $('#log-count').textContent = `${list.length} of ${total} shown`;
  $('#logs').innerHTML = list.map((m) => `<tr><td>${fmt(m.createdAt)}</td><td>${esc(m.sessionId)}</td>
    <td>${m.direction === 'in' ? '⬅ in' : 'out ➡'}</td><td>+${esc(m.to)}</td><td class="msg">${esc(m.text)}</td>
    <td><span class="badge ${esc(m.status)}">${esc(m.status)}</span>${m.error ? `<br><span class="muted">${esc(m.error)}</span>` : ''}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="muted">No messages match these filters</td></tr>';
}
let logTimer;
$('#log-filters').addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 250); });
$('#log-filters').addEventListener('submit', (e) => e.preventDefault());
$('#log-reset').addEventListener('click', () => { $('#log-filters').reset(); loadLogs(); });

/* ---------- API keys ---------- */
$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = await api('/keys', { method: 'POST', body: { name: e.target.name.value } });
  e.target.reset();
  const box = $('#new-key');
  box.classList.remove('hidden');
  box.innerHTML = `<strong>New key — copy it now, it won't be shown again:</strong><pre>${esc(k.key)}</pre>`;
  loadKeys();
});
async function loadKeys() {
  const list = await api('/keys');
  $('#keys').innerHTML = list.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.key)}</code></td><td>${fmt(k.createdAt)}</td>
    <td><button class="btn sm danger" data-del="${k.id}">Revoke</button></td></tr>`).join('') ||
    '<tr><td colspan="4" class="muted">No API keys</td></tr>';
}
$('#keys').addEventListener('click', async (e) => {
  if (e.target.dataset.del && confirm('Revoke this key?')) { await api(`/keys/${e.target.dataset.del}`, { method: 'DELETE' }); loadKeys(); }
});

/* ---------- Docs ---------- */
function renderDocs() {
  $('#base-url').textContent = `${location.origin}/api`;
  $('#curl-example').textContent =
`curl -X POST ${location.origin}/api/messages/text \\
  -H "x-api-key: wak_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"sessionId":"sales-1","to":"919876543210","text":"Hello from API"}'`;
}

/* ---------- Boot ---------- */
if (token) showApp(); else showLogin();
