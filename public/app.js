const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => new Date(d).toLocaleString();

let token = '';
try { token = localStorage.getItem('wa_token') || ''; } catch {}
let currentTab = null;      // null = the role's home tab
let pollTimer = null;
let me = null;              // signed-in user { id, name, role, departmentIds }
let directory = [];         // all active users, for "assign to" pickers
let departments = [];
const CAMPAIGN_STATUS = {
  draft: 'draft', running: 'running', paused: 'paused', completed: 'completed',
  stopped_limit: 'daily limit reached', waiting_quiet: 'waiting (quiet hours)',
};
const isStaff = () => me && (me.role === 'admin' || me.role === 'manager');

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
  me = null;
  currentTab = null;
  dashData = null;
  riskData = null;
  riskBadgeAt = 0;
  selectedTicket = null;
  const detail = $('#ticket-detail');
  detail.dataset.id = '';
  detail.innerHTML = '<p class="muted empty">Select a ticket to view the conversation.</p>';
  try { localStorage.removeItem('wa_token'); } catch {}
  clearInterval(pollTimer);
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
async function showApp() {
  try { me = await api('/auth/me'); } catch { return showLogin(); }
  await loadPeople().catch(() => {});
  // show only the menu items this role may use
  $$('[data-roles]').forEach((el) => el.classList.toggle('hidden', !el.dataset.roles.split(',').includes(me.role)));
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = me.role;
  const allowed = currentTab && $(`.sidebar a[data-tab="${currentTab}"]`);
  if (!allowed || allowed.classList.contains('hidden')) currentTab = me.role === 'agent' ? 'tickets' : 'dashboard';
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  switchTab(currentTab);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(currentTab), 3000);
}
async function loadPeople() {
  [directory, departments] = await Promise.all([api('/users/directory'), api('/departments')]);
}
const deptName = (id) => departments.find((d) => d.id === id)?.name || '';
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { token: t } = await api('/auth/login', { method: 'POST', body: Object.fromEntries(f) });
    token = t;
    try { localStorage.setItem('wa_token', t); } catch {}
    $('#login-error').textContent = '';
    e.target.reset();
    showApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#password-btn').addEventListener('click', async () => {
  const currentPassword = prompt('Current password');
  if (!currentPassword) return;
  const newPassword = prompt('New password (at least 8 characters)');
  if (!newPassword) return;
  if (prompt('Repeat new password') !== newPassword) return alert('Passwords do not match');
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
    alert('Password changed');
  } catch (err) { alert(err.message); }
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
    if (tab === 'dashboard') await loadDashboard();
    if (tab === 'sessions') await loadSessions();
    loadTicketBadge();
    loadRiskBadge();
    if (tab === 'risk') await loadRisk();
    if (tab === 'send' || tab === 'campaigns' || tab === 'tickets' || tab === 'departments') await loadSessionSelects();
    if (tab === 'tickets') await loadTickets();
    if (tab === 'users') await loadUsers();
    if (tab === 'departments') await loadDepartments();
    if (tab === 'contacts' && !$('#contact-search').matches(':focus')) await loadContacts();
    if (tab === 'campaigns') await loadCampaigns();
    if (tab === 'logs') await loadLogs();
    if (tab === 'keys') await loadKeys();
    if (tab === 'docs') renderDocs();
  } catch (e) { console.warn(e.message); }
}

/* ---------- Dashboard ---------- */
let dashDays = 7;
let dashData = null;
let dashLoadedAt = 0;
let activityTable = false;

const compact = (n) => (n == null ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : n.toLocaleString());
const minutes = (m) => (m == null ? '—' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`);
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// "▲ 12% vs previous 7 days", coloured by whether the change is good
function delta(cur, prev, { upIsGood = true, unit = '%' } = {}) {
  const period = `vs previous ${dashDays} days`;
  if (cur == null || prev == null) return `<div class="delta">${period}: —</div>`;
  if (prev === 0) return `<div class="delta">${cur ? 'New activity' : 'No change'} ${period}</div>`;
  const change = unit === '%' ? Math.round(((cur - prev) / prev) * 100) : Math.round((cur - prev) * 10) / 10;
  if (change === 0) return `<div class="delta"><b>No change</b> ${period}</div>`;
  const good = (change > 0) === upIsGood;
  return `<div class="delta ${good ? 'good' : 'bad'}"><b>${change > 0 ? '▲' : '▼'} ${Math.abs(change)}${unit === '%' ? '%' : ' pts'}</b> ${period}</div>`;
}
const kpi = (label, value, deltaHtml = '', cls = '', inner = '') =>
  `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${deltaHtml}${inner}</div>`;

$('#dash-range').addEventListener('click', (e) => {
  const d = Number(e.target.dataset.days);
  if (!d) return;
  dashDays = d;
  $$('#dash-range button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadDashboard(true);
});
$('.dashboard').addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) switchTab(go.dataset.goto);
  const t = e.target.closest('[data-ticket]');
  if (t) { selectedTicket = t.dataset.ticket; renderedTicketAt = null; switchTab('tickets'); }
});
$('#activity-table-btn').addEventListener('click', (e) => {
  activityTable = !activityTable;
  e.target.setAttribute('aria-pressed', activityTable);
  e.target.textContent = activityTable ? 'Chart' : 'Table';
  $('#chart-activity').classList.toggle('hidden', activityTable);
  $('#activity-table').classList.toggle('hidden', !activityTable);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => currentTab === 'dashboard' && dashData && renderActivityChart(dashData.series), 150);
});

// The dashboard refreshes every 15 s (the rest of the app polls every 3 s).
async function loadDashboard(force = false) {
  if (!force && Date.now() - dashLoadedAt < 15000 && dashData) {
    if (dashData.series) renderActivityChart(dashData.series); // size may have changed while hidden
    return;
  }
  const d = await api(`/dashboard?days=${dashDays}`);
  dashData = d;
  dashLoadedAt = Date.now();
  const hour = new Date().getHours();
  $('#dash-greeting').textContent = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${me.name.split(' ')[0]}`;
  $('#dash-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  renderKpis(d);
  renderBars($('#chart-status'), [
    ['Open', d.tickets.open], ['Pending', d.tickets.pending], ['Resolved', d.tickets.resolved], ['Closed', d.tickets.closed],
  ], 'tickets', 'No tickets yet');
  $('#ticket-mini').innerHTML = [
    [d.tickets.created.current, `Created · ${d.days} days`], [d.tickets.resolvedCount.current, `Resolved · ${d.days} days`],
    [d.tickets.unassigned, 'Unassigned'], [d.tickets.urgent, 'Urgent'],
  ].map(([v, l]) => `<div><b>${compact(v)}</b><span>${l}</span></div>`).join('');
  renderBars($('#chart-depts'), d.departments.map((x) => [x.name, x.active]), 'active tickets', 'No active tickets — all caught up');
  renderAttention(d.attention);
  if (d.series) {
    renderActivityChart(d.series);
    renderActivityTable(d.series);
    renderSessions(d.sessions);
    renderCampaignsPanel(d.campaigns);
    renderTeam(d.team);
    renderActivityFeed(d.activity);
  }
}

function renderKpis(d) {
  const t = d.tickets;
  let html;
  if (d.messages) {
    const m = d.messages;
    html = kpi(`Messages sent · last ${d.days} days`, compact(m.current.sent), delta(m.current.sent, m.previous.sent),
      'hero', sparkline(d.series.map((x) => x.sent))) +
      kpi('Messages received', compact(m.current.received), delta(m.current.received, m.previous.received)) +
      kpi('Send success rate', m.current.successRate == null ? '—' : `${m.current.successRate}%`,
        delta(m.current.successRate, m.previous.successRate, { unit: 'pts' })) +
      kpi('Open tickets', compact(t.open), `<div class="delta">${t.unassigned} unassigned · ${t.urgent} urgent</div>`) +
      kpi('Avg first response', minutes(t.avgFirstResponseMin.current),
        delta(t.avgFirstResponseMin.current, t.avgFirstResponseMin.previous, { upIsGood: false }));
    $('#contacts-sub').textContent =
      `${compact(d.contacts.total)} contacts · +${d.contacts.added.current} new · ${d.contacts.optedOut} opted out`;
  } else {
    html = kpi('My active tickets', compact(t.mine), `<div class="delta">${t.open} open in your departments</div>`, 'hero') +
      kpi('Open tickets', compact(t.open), '<div class="delta">Waiting for a reply</div>') +
      kpi('Unassigned', compact(t.unassigned), '<div class="delta">Waiting for someone to pick up</div>') +
      kpi(`Resolved · ${d.days} days`, compact(t.resolvedCount.current), delta(t.resolvedCount.current, t.resolvedCount.previous)) +
      kpi('Avg first response', minutes(t.avgFirstResponseMin.current),
        delta(t.avgFirstResponseMin.current, t.avgFirstResponseMin.previous, { upIsGood: false }));
  }
  $('#dash-kpis').innerHTML = html;
}

function sparkline(values) {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1), w = 200, h = 56;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 4 - (v / max) * (h - 8)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="rgba(255,255,255,.12)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// Horizontal bars, one hue (magnitude). Value at the tip, hover tooltip.
function renderBars(el, rows, unit, emptyText) {
  const max = Math.max(...rows.map((r) => r[1]), 0);
  if (!max) { el.innerHTML = `<div class="empty-state">${emptyText}</div>`; return; }
  el.innerHTML = `<div class="hbars">${rows.map(([name, v]) => `
    <div class="hbar" data-tip="${esc(name)}|${v} ${esc(unit)}">
      <span class="name">${esc(name)}</span>
      <span class="track"><span class="bar" style="width:${Math.max((v / max) * 100, v ? 2 : 0)}%"></span></span>
      <span class="num">${compact(v)}</span>
    </div>`).join('')}</div>`;
}

const SERIES = [
  { key: 'sent', label: 'Sent', color: 'var(--series-1)' },
  { key: 'received', label: 'Received', color: 'var(--series-2)' },
];

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

// Two-series line chart (one axis) with crosshair + tooltip on hover.
function renderActivityChart(series) {
  const el = $('#chart-activity');
  $('#activity-legend').innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  const W = el.clientWidth || 600, H = el.clientHeight || 260;
  const m = { top: 12, right: 78, bottom: 26, left: 36 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...series.flatMap((d) => [d.sent, d.received]), 0));
  const x = (i) => m.left + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v) => m.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const every = Math.ceil(series.length / Math.max(2, Math.floor(iw / 70)));
  const path = (key) => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
  const last = series.length - 1;

  // end labels, unless they would collide
  const ends = SERIES.map((s) => ({ ...s, v: series[last][s.key], y: y(series[last][s.key]) }));
  const collide = Math.abs(ends[0].y - ends[1].y) < 16;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Messages sent and received per day over the last ${series.length} days">
    ${ticks.map((t) => `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? 'var(--grid)' : 'var(--axis)'}" stroke-width="1"/>
      <text class="tick" x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
    ${series.map((d, i) => (i % every === 0 || i === last) && (i === last || last - i >= every / 2)
      ? `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${shortDate(d.date)}</text>` : '').join('')}
    <path d="${path('sent')}L${x(last)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--series-1)" opacity=".1"/>
    ${SERIES.map((s) => `<path d="${path(s.key)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
    ${ends.map((e) => `<circle cx="${x(last)}" cy="${e.y}" r="4.5" fill="${e.color}" stroke="#fff" stroke-width="2"/>`).join('')}
    ${collide ? '' : ends.map((e) => `<text class="end-label" x="${x(last) + 10}" y="${e.y + 4}">${compact(e.v)} <tspan fill="var(--ink-muted)" font-weight="400">${e.label}</tspan></text>`).join('')}
    <g id="xhair" visibility="hidden">
      <line y1="${m.top}" y2="${m.top + ih}" stroke="var(--axis)" stroke-width="1"/>
      ${SERIES.map((s) => `<circle data-k="${s.key}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('')}
    </g>
    <rect x="${m.left}" y="${m.top}" width="${iw}" height="${ih}" fill="transparent" id="hit"/>
  </svg>`;

  const svg = el.querySelector('svg'), xh = svg.querySelector('#xhair');
  svg.querySelector('#hit').addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(last, Math.round(((px - m.left) / iw) * last)));
    const d = series[i];
    xh.setAttribute('visibility', 'visible');
    xh.querySelector('line').setAttribute('x1', x(i));
    xh.querySelector('line').setAttribute('x2', x(i));
    xh.querySelectorAll('circle').forEach((c) => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(d[c.dataset.k])); });
    showTip(ev, `<div class="t-title">${new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      ${SERIES.map((s) => `<div class="t-row"><span><i style="background:${s.color}"></i>${s.label}</span><b>${d[s.key].toLocaleString()}</b></div>`).join('')}
      <div class="t-row"><span><i style="background:#d03b3b"></i>Failed</span><b>${d.failed.toLocaleString()}</b></div>`);
  });
  svg.querySelector('#hit').addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}

function renderActivityTable(series) {
  $('#activity-table').innerHTML = `<table><thead><tr><th>Date</th><th class="n">Sent</th><th class="n">Received</th><th class="n">Failed</th></tr></thead>
    <tbody>${[...series].reverse().map((d) => `<tr><td>${shortDate(d.date)}</td><td class="n">${d.sent}</td><td class="n">${d.received}</td><td class="n">${d.failed}</td></tr>`).join('')}</tbody></table>`;
}

/* tooltip shared by all dashboard charts */
const tip = $('#viz-tooltip');
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const pad = 14, r = tip.getBoundingClientRect();
  let left = ev.clientX + pad, top = ev.clientY + pad;
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - pad;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() { tip.classList.add('hidden'); }
$('.dashboard').addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  const [title, body] = el.dataset.tip.split('|');
  showTip(e, `<div class="t-title">${esc(title)}</div><div>${esc(body)}</div>`);
});
$('.dashboard').addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) hideTip(); });

function renderAttention(list) {
  $('#dash-attention').innerHTML = list.length ? `<div class="plist">${list.map((t) => `
    <div class="item link" data-ticket="${t.id}">
      <div class="grow">
        <div class="title">#${t.number} · ${esc(t.name)}</div>
        <div class="sub">${esc(t.subject)}</div>
      </div>
      ${t.priority !== 'normal' ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
      ${t.unread ? `<span class="unread">${t.unread}</span>` : ''}
      <span class="muted small">${ago(t.updatedAt)}</span>
    </div>`).join('')}</div>` : '<div class="empty-state">No open tickets waiting. Nice work!</div>';
}

const SESSION_STATUS = {
  connected: ['good', 'Connected'], qr: ['warning', 'Waiting for QR scan'], starting: ['warning', 'Starting'],
  disconnected: ['critical', 'Disconnected'], logged_out: ['critical', 'Logged out'],
};
function renderSessions(list) {
  $('#dash-sessions').innerHTML = list.length ? `<div class="plist">${list.map((s) => {
    const [cls, label] = SESSION_STATUS[s.status] || ['warning', s.status];
    const used = Math.min(100, Math.round((s.sentToday / s.dailyLimit) * 100));
    return `<div class="item"><div class="grow">
        <div class="row space-between" style="margin:0"><span class="title">${esc(s.id)}</span><span class="status-dot ${cls}">${label}</span></div>
        <div class="sub">${s.user?.id ? '+' + esc(s.user.id.split(/[:@]/)[0]) : 'Not linked'} · ${s.sentToday}/${s.dailyLimit} campaign sends today</div>
        <div class="meter ${used >= 95 ? 'crit' : used >= 80 ? 'warn' : ''}" data-tip="${esc(s.id)}|${used}% of today's limit used"><div style="width:${used}%"></div></div>
      </div></div>`;
  }).join('')}</div>` : '<div class="empty-state">No WhatsApp numbers linked yet.</div>';
}

function renderCampaignsPanel(list) {
  $('#dash-campaigns').innerHTML = list.length ? `<div class="plist">${list.map((c) => {
    const done = c.stats.sent + c.stats.failed + c.stats.skipped;
    const p = c.stats.total ? Math.round((done / c.stats.total) * 100) : 0;
    return `<div class="item"><div class="grow">
      <div class="row space-between" style="margin:0"><span class="title">${esc(c.name)}</span><span class="badge ${esc(c.status)}">${esc(CAMPAIGN_STATUS[c.status] || c.status)}</span></div>
      <div class="sub">${c.stats.sent} sent · ${c.stats.failed} failed · ${c.stats.total} recipients</div>
      <div class="meter" data-tip="${esc(c.name)}|${p}% processed"><div style="width:${p}%"></div></div>
    </div></div>`;
  }).join('')}</div>` : '<div class="empty-state">No campaigns yet.</div>';
}

function renderTeam(list) {
  $('#team-sub').textContent = `Last ${dashDays} days`;
  $('#dash-team').innerHTML = list.length ? `<table class="team"><thead><tr><th>Member</th><th class="n">Active tickets</th><th class="n">Resolved</th><th class="n">Avg first response</th></tr></thead>
    <tbody>${list.map((u) => `<tr>
      <td><div class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(u.name))}</span><span>${esc(u.name)}<br><span class="muted small">${u.role}</span></span></div></td>
      <td class="n">${u.active}</td><td class="n"><strong>${u.resolved}</strong></td><td class="n">${minutes(u.avgFirstResponseMin)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty-state">No team members yet.</div>';
}

function renderActivityFeed(list) {
  $('#dash-activity').innerHTML = list.length ? `<div class="plist">${list.map((m) => `
    <div class="item">
      <span class="dir ${m.direction === 'in' ? 'in' : 'out'}" title="${m.direction === 'in' ? 'Received' : 'Sent'}"><svg class="ic"><use href="#i-${m.direction === 'in' ? 'in' : 'out'}"/></svg></span>
      <div class="grow"><div class="title">+${esc(m.to)} <span class="muted small" style="font-weight:400">via ${esc(m.sessionId)}</span></div><div class="sub">${esc(m.text)}</div></div>
      ${m.status === 'failed' ? '<span class="badge failed">failed</span>' : ''}
      <span class="muted small">${ago(m.createdAt)}</span>
    </div>`).join('')}</div>` : '<div class="empty-state">No messages yet.</div>';
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

/* ---------- Tickets ---------- */
let ticketStatus = 'open,pending';
let selectedTicket = null;     // id
let renderedTicketAt = null;   // updatedAt of the thread currently on screen
let composeMode = 'reply';     // reply | note

// Users who may own a ticket in this department: its members plus admins.
const eligibleAssignees = (deptId) =>
  directory.filter((u) => !deptId || u.role === 'admin' || u.departmentIds?.includes(deptId));
// Departments this user may file tickets into.
const myDepartments = () => (me.role === 'admin' ? departments : departments.filter((d) => me.departmentIds.includes(d.id)));
const options = (items, selected) =>
  items.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');

function fillTicketPickers() {
  fillSelect($('#ticket-filters').departmentId, 'All departments',
    [...departments.map((d) => [d.id, d.name]), ['none', 'No department']]);
  const nf = $('#new-ticket-form').departmentId;
  const html = (me.role === 'admin' ? '<option value="">Auto (routing rules)</option>' : '') +
    options(myDepartments().map((d) => [d.id, d.name]));
  if (nf.dataset.html !== html) { nf.innerHTML = html; nf.dataset.html = html; }
}
const ago = (d) => {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

async function loadTicketBadge() {
  const s = await api('/tickets/stats').catch(() => null);
  if (!s) return;
  const b = $('#ticket-badge');
  b.textContent = s.open;
  b.classList.toggle('hidden', !s.open);
}

$('#ticket-status-tabs').addEventListener('click', (e) => {
  const st = e.target.dataset.status;
  if (st === undefined) return;
  ticketStatus = st;
  $$('#ticket-status-tabs button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadTickets();
});
let ticketFilterTimer;
$('#ticket-filters').addEventListener('input', () => { clearTimeout(ticketFilterTimer); ticketFilterTimer = setTimeout(loadTickets, 250); });
$('#ticket-filters').addEventListener('submit', (e) => e.preventDefault());

async function loadTickets() {
  await loadPeople();
  fillTicketPickers();
  const f = $('#ticket-filters');
  const p = new URLSearchParams({ sort: f.sort.value });
  if (ticketStatus) p.set('status', ticketStatus);
  for (const k of ['q', 'priority', 'assignee', 'departmentId']) if (f[k].value.trim()) p.set(k, f[k].value.trim());
  const list = await api(`/tickets?${p}`);
  $('#ticket-list').innerHTML = list.map((t) => `
    <div class="t-item ${t.id === selectedTicket ? 'active' : ''}" data-id="${t.id}">
      <div class="top"><span class="who">#${t.number} · ${esc(t.name || '+' + t.phone)}</span>
        <span class="muted">${ago(t.updatedAt)} ${t.unread ? `<span class="unread">${t.unread}</span>` : ''}</span></div>
      <div class="subj">${esc(t.subject)}</div>
      ${t.lastMessage ? `<div class="last">${t.lastMessage.type === 'out' ? '↩ ' : ''}${esc(t.lastMessage.text)}</div>` : ''}
      <div class="meta"><span class="badge ${t.status}">${t.status}</span>
        ${t.priority !== 'normal' ? `<span class="badge ${t.priority}">${t.priority}</span>` : ''}
        ${t.departmentName ? `<span class="badge dept">${esc(t.departmentName)}</span>` : ''}
        ${t.assignee ? `<span class="badge">👤 ${esc(t.assignee === me.id ? 'Me' : t.assigneeName)}</span>` : '<span class="badge">unassigned</span>'}</div>
    </div>`).join('') || '<p class="muted" style="padding:12px">No tickets here.</p>';
  if (selectedTicket) await loadTicketDetail();
}

$('#ticket-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.t-item');
  if (!item) return;
  selectedTicket = item.dataset.id;
  renderedTicketAt = null;
  $$('.t-item').forEach((x) => x.classList.toggle('active', x === item));
  await api(`/tickets/${selectedTicket}/read`, { method: 'POST' }).catch(() => {});
  await loadTicketDetail();
});

async function loadTicketDetail() {
  let t;
  try { t = await api(`/tickets/${selectedTicket}`); } catch {
    selectedTicket = null;
    $('#ticket-detail').innerHTML = '<p class="muted empty">Select a ticket to view the conversation.</p>';
    return;
  }
  if (t.unread) api(`/tickets/${t.id}/read`, { method: 'POST' }).catch(() => {}); // agent is looking at it
  const box = $('#ticket-detail');
  if (box.dataset.id !== t.id) {
    box.dataset.id = t.id;
    box.innerHTML = `
      <div class="td-head">
        <h3 id="td-title"></h3>
        <div class="muted" id="td-sub"></div>
        <div class="td-controls">
          <select id="td-status">${['open', 'pending', 'resolved', 'closed'].map((s) => `<option>${s}</option>`).join('')}</select>
          <select id="td-priority">${['low', 'normal', 'high', 'urgent'].map((s) => `<option>${s}</option>`).join('')}</select>
          <select id="td-department" title="Transfer to department"></select>
          <select id="td-assignee" title="Assignee"></select>
          <button class="btn sm" id="td-assign-me">Assign to me</button>
          ${isStaff() ? '<button class="btn sm danger" id="td-delete">Delete</button>' : ''}
        </div>
      </div>
      <div class="thread" id="td-thread"></div>
      <form class="composer" id="td-composer">
        <div class="row space-between" style="margin:0">
          <div class="mode-tabs"><button type="button" data-mode="reply">Reply on WhatsApp</button><button type="button" data-mode="note">Internal note</button></div>
          <span class="muted" id="td-hint"></span>
        </div>
        <textarea name="text" rows="3" placeholder="Type your reply… (Ctrl+Enter to send)"></textarea>
        <div class="row">
          <input type="file" name="file" />
          <button class="btn primary" id="td-send">Send</button>
          <button type="button" class="btn" id="td-send-resolve">Send &amp; resolve</button>
        </div>
      </form>`;
    bindTicketDetail();
    setComposeMode(composeMode);
  }
  $('#td-title').textContent = `#${t.number} · ${t.subject}`;
  $('#td-sub').textContent = `${t.name ? t.name + ' · ' : ''}+${t.phone} · via ${t.sessionId} · opened ${fmt(t.createdAt)}`;
  const deptSel = $('#td-department'), asgSel = $('#td-assignee');
  if (!deptSel.matches(':focus')) {
    deptSel.innerHTML = options([['', 'No department'], ...departments.map((d) => [d.id, d.name])], t.departmentId || '');
  }
  if (!asgSel.matches(':focus')) {
    asgSel.innerHTML = options([['', 'Unassigned'],
      ...eligibleAssignees(t.departmentId).map((u) => [u.id, u.id === me.id ? `${u.name} (me)` : u.name])], t.assignee || '');
  }
  $('#td-assign-me').classList.toggle('hidden', t.assignee === me.id || me.apiKey);
  for (const [id, v] of [['#td-status', t.status], ['#td-priority', t.priority]]) {
    if (!$(id).matches(':focus')) $(id).value = v;
  }
  if (renderedTicketAt !== t.updatedAt) {
    renderedTicketAt = t.updatedAt;
    const th = $('#td-thread');
    th.innerHTML = t.thread.map((e) => e.type === 'event'
      ? `<div class="event">${esc(e.text)} · ${fmt(e.at)}</div>`
      : `<div class="bubble ${e.type} ${e.status === 'failed' ? 'failed' : ''}">${e.type === 'note' ? '<strong>Note:</strong> ' : ''}${esc(e.text)}
          <div class="by">${esc(e.by || '')} · ${fmt(e.at)}${e.status === 'failed' ? ` · <span class="error">failed: ${esc(e.error)}</span>` : ''}</div></div>`).join('');
    th.scrollTop = th.scrollHeight;
  }
}

function setComposeMode(mode) {
  composeMode = mode;
  $$('#td-composer .mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#td-composer').classList.toggle('note-mode', mode === 'note');
  $('#td-composer [name=file]').classList.toggle('hidden', mode === 'note');
  $('#td-send-resolve').classList.toggle('hidden', mode === 'note');
  $('#td-send').textContent = mode === 'note' ? 'Add note' : 'Send';
  $('#td-hint').textContent = mode === 'note' ? 'Only your team sees notes' : 'Customer receives this on WhatsApp';
}

async function patchTicket(body) {
  try {
    await api(`/tickets/${selectedTicket}`, { method: 'PATCH', body });
  } catch (err) { alert(err.message); }
  renderedTicketAt = null;
  await loadTickets();
}

function bindTicketDetail() {
  $('#td-status').addEventListener('change', (e) => patchTicket({ status: e.target.value }));
  $('#td-priority').addEventListener('change', (e) => patchTicket({ priority: e.target.value }));
  $('#td-assignee').addEventListener('change', (e) => patchTicket({ assignee: e.target.value }));
  $('#td-department').addEventListener('change', (e) => {
    const name = e.target.value ? deptName(e.target.value) : 'No department';
    if (!confirm(`Transfer this ticket to ${name}?`)) { renderedTicketAt = null; return loadTicketDetail(); }
    patchTicket({ departmentId: e.target.value || null });
  });
  $('#td-assign-me').addEventListener('click', () => patchTicket({ assignee: me.id }));
  $('#td-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this ticket permanently?')) return;
    await api(`/tickets/${selectedTicket}`, { method: 'DELETE' });
    selectedTicket = null;
    $('#ticket-detail').dataset.id = '';
    loadTickets();
  });
  $('#td-composer .mode-tabs').addEventListener('click', (e) => e.target.dataset.mode && setComposeMode(e.target.dataset.mode));
  const form = $('#td-composer');
  form.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) form.requestSubmit(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); sendTicketMessage(false); });
  $('#td-send-resolve').addEventListener('click', () => sendTicketMessage(true));
}

async function sendTicketMessage(resolve) {
  const form = $('#td-composer');
  const text = form.text.value.trim();
  const file = form.file.files[0];
  if (!text && !file) return;
  const btns = $$('#td-composer button.btn');
  btns.forEach((b) => (b.disabled = true));
  try {
    if (composeMode === 'note') {
      await api(`/tickets/${selectedTicket}/notes`, { method: 'POST', body: { text } });
    } else {
      const fd = new FormData();
      fd.append('text', text);
      if (file) fd.append('file', file);
      await api(`/tickets/${selectedTicket}/reply`, { method: 'POST', form: fd });
      if (resolve) await api(`/tickets/${selectedTicket}`, { method: 'PATCH', body: { status: 'resolved', notify: false } });
    }
    form.reset();
    renderedTicketAt = null;
    await loadTickets();
  } catch (err) { alert(err.message); renderedTicketAt = null; loadTicketDetail(); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}

$('#new-ticket-btn').addEventListener('click', () => $('#new-ticket-form').classList.toggle('hidden'));
$('#new-ticket-cancel').addEventListener('click', () => $('#new-ticket-form').classList.add('hidden'));
$('#new-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const t = await api('/tickets', { method: 'POST', body: {
      sessionId: f.sessionId.value, phone: f.phone.value, name: f.name.value, subject: f.subject.value,
      priority: f.priority.value, message: f.message.value, sendMessage: f.sendMessage.checked,
      ...(f.departmentId.value ? { departmentId: f.departmentId.value } : {}),
      ...(f.assignToMe.checked ? { assignee: me.id } : {}),
    } });
    f.reset();
    f.classList.add('hidden');
    selectedTicket = t.id;
    renderedTicketAt = null;
    loadTickets();
  } catch (err) { alert(err.message); }
});

/* ---------- Block risk (admin) ---------- */
const LEVELS = {
  low: ['Low risk', 'i-check', 'var(--good)'],
  medium: ['Medium risk', 'i-alert', 'var(--warning)'],
  high: ['High risk', 'i-alert', 'var(--serious)'],
  critical: ['Critical risk', 'i-x', 'var(--critical)'],
};
const SIG_STATUS = {
  good: ['Safe', 'i-check'], warning: ['Watch', 'i-alert'], serious: ['Risky', 'i-alert'],
  critical: ['Danger', 'i-x'], info: ['Not enough data', 'i-info'],
};
let riskData = null;
let riskLoadedAt = 0;
let riskBadgeAt = 0;

// Half-circle gauge, 0–100
function gauge(score, color) {
  const r = 80, cx = 100, cy = 100, a = Math.PI * (1 - Math.min(100, score) / 100);
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `<div class="gauge"><svg viewBox="0 0 200 112" aria-hidden="true">
    <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="#e7ebe9" stroke-width="14" stroke-linecap="round"/>
    ${score > 0 ? `<path d="M20,100 A80,80 0 0 1 ${x.toFixed(1)},${y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>` : ''}
  </svg><div class="score"><b>${score}</b><span>risk score / 100</span></div></div>`;
}

async function loadRiskBadge() {
  if (me?.role !== 'admin' || Date.now() - riskBadgeAt < 60000) return;
  riskBadgeAt = Date.now();
  const d = await api('/health').catch(() => null);
  if (!d) return;
  const n = d.sessions.filter((s) => s.level === 'high' || s.level === 'critical').length;
  $('#risk-badge').textContent = n;
  $('#risk-badge').classList.toggle('hidden', !n);
}

async function loadRisk(force = false) {
  if (!force && riskData && Date.now() - riskLoadedAt < 30000) return;
  const d = await api('/health');
  riskData = d;
  riskLoadedAt = Date.now();
  riskBadgeAt = 0;
  $('#risk-numbers').innerHTML = d.sessions.length ? d.sessions.map(renderRiskCard).join('')
    : '<div class="card empty-state">No WhatsApp numbers yet. Link one on the WhatsApp Numbers page to see its block risk.</div>';
  const f = $('#protect-form');
  if (!f.contains(document.activeElement) && !f.dataset.dirty) fillProtectForm(d.settings);
}

function renderRiskCard(h) {
  const [label, icon, color] = LEVELS[h.level];
  const todo = h.signals.filter((s) => s.status !== 'good' && s.status !== 'info').slice(0, 3);
  const used = h.limits.effective ? Math.min(100, Math.round((h.stats.todaySent / h.limits.effective) * 100)) : 0;
  const phone = h.user?.id ? '+' + h.user.id.split(/[:@]/)[0] : 'Not connected';
  return `<div class="card risk-card">
    <div class="risk-summary">
      <div><h3>${esc(h.sessionId)}</h3><div class="muted small">${esc(phone)} · ${esc(h.status.replace('_', ' '))}</div></div>
      ${gauge(h.score, color)}
      <span class="level ${h.level}"><svg class="ic"><use href="#${icon}"/></svg>${label}</span>
      <div class="facts">
        <div><b>${h.stats.sent}</b><span>sent · 7 days</span></div>
        <div><b>${h.stats.replied}</b><span>people replied</span></div>
        <div><b>${h.ageDays}d</b><span>number age</span></div>
        <div><b>${h.limits.effective}</b><span>safe limit today</span></div>
      </div>
      <div>
        <div class="row space-between small" style="margin:0 0 4px"><span class="muted">Sent today</span><span><b>${h.stats.todaySent}</b> / ${h.limits.effective}</span></div>
        <div class="meter ${used >= 95 ? 'crit' : used >= 80 ? 'warn' : ''}"><div style="width:${used}%"></div></div>
      </div>
      <label class="age-edit">Number in use since (for warm-up)
        <input type="date" data-age="${esc(h.sessionId)}" max="${new Date().toISOString().slice(0, 10)}" value="${h.numberSince ? h.numberSince.slice(0, 10) : ''}" />
      </label>
    </div>
    <div class="risk-detail">
      <div class="actions-now ${todo.length ? '' : 'ok'}">
        <h4>${todo.length ? 'What to do now' : 'Looking good'}</h4>
        ${todo.length ? `<ol>${todo.map((s) => `<li><strong>${esc(s.label)}:</strong> ${esc(s.fix)}</li>`).join('')}</ol>`
          : `<div class="small">No risky patterns found for this number in the last 7 days. Keep following the tips below.${h.stats.sent < 20 ? ' (Few messages sent yet, so some checks need more data.)' : ''}</div>`}
      </div>
      <table class="signals">
        <thead><tr><th>Signal</th><th>This number</th><th>Safe range</th><th>Status</th></tr></thead>
        <tbody>${h.signals.map((s) => {
          const [sl, si] = SIG_STATUS[s.status];
          return `<tr>
            <td><div class="sig-name">${esc(s.label)}</div><div class="sig-why">${esc(s.why)}</div>
              ${s.status !== 'good' && s.status !== 'info' ? `<div class="sig-fix"><strong>Fix:</strong> ${esc(s.fix)}</div>` : ''}</td>
            <td class="val">${s.enough ? esc(`${s.value}${s.unit && !s.unit.startsWith('/') ? s.unit : s.unit ? ' ' + s.unit : ''}`) : '—'}</td>
            <td class="safe">${esc(s.safe)}</td>
            <td><span class="sig-status ${s.status}"><svg class="ic"><use href="#${si}"/></svg>${sl}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

$('#risk-refresh').addEventListener('click', () => loadRisk(true));
$('#risk-numbers').addEventListener('change', async (e) => {
  const id = e.target.dataset.age;
  if (!id) return;
  try {
    await api(`/sessions/${encodeURIComponent(id)}/meta`, { method: 'PATCH', body: { numberSince: e.target.value || null } });
    loadRisk(true);
  } catch (err) { alert(err.message); }
});

/* protection settings form */
const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
$('#protect-form').quietStart.innerHTML = hourOpts;
$('#protect-form').quietEnd.innerHTML = hourOpts;
function fillProtectForm(s) {
  const f = $('#protect-form');
  f.minDelay.value = Math.round(s.minDelayMs / 1000);
  f.maxDelay.value = Math.round(s.maxDelayMs / 1000);
  f.dailyLimit.value = s.dailyLimit;
  f.warmup.checked = s.warmup;
  f.quietEnabled.checked = s.quietHours.enabled;
  f.quietStart.value = s.quietHours.start;
  f.quietEnd.value = s.quietHours.end;
  f.autoPause.checked = s.autoPause.enabled;
  f.failRate.value = s.autoPause.failRate;
  f.optOutRate.value = s.autoPause.optOutRate;
}
$('#protect-form').addEventListener('input', (e) => { e.currentTarget.dataset.dirty = '1'; $('#protect-result').textContent = 'Unsaved changes'; });
$('#protect-recommended').addEventListener('click', () => {
  fillProtectForm(riskData.recommended);
  $('#protect-form').dataset.dirty = '1';
  $('#protect-result').textContent = 'Recommended values filled in. Save to apply.';
});
$('#protect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const s = await api('/settings', { method: 'PUT', body: {
      minDelayMs: f.minDelay.value * 1000, maxDelayMs: f.maxDelay.value * 1000, dailyLimit: Number(f.dailyLimit.value),
      warmup: f.warmup.checked,
      quietHours: { enabled: f.quietEnabled.checked, start: Number(f.quietStart.value), end: Number(f.quietEnd.value) },
      autoPause: { enabled: f.autoPause.checked, failRate: Number(f.failRate.value), optOutRate: Number(f.optOutRate.value) },
    } });
    delete f.dataset.dirty;
    fillProtectForm(s);
    $('#protect-result').textContent = 'Saved ✓';
    loadRisk(true);
  } catch (err) { $('#protect-result').textContent = err.message; }
});

/* ---------- Users (admin) ---------- */
const ROLE_HELP = {
  admin: 'Everything, incl. users, departments, numbers and API keys',
  manager: 'Tickets of their departments + contacts, campaigns, sending, logs',
  agent: 'Only tickets of their departments',
};
const checkboxes = (name, items, checked = []) => items.length
  ? items.map(([v, l]) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(v)}" ${checked.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')
  : '<span class="muted">None yet</span>';

function resetUserForm() {
  const f = $('#user-form');
  f.reset();
  f.id.value = '';
  f.username.disabled = false;
  f.password.required = true;
  f.password.placeholder = 'Password (min 8 characters)';
  $('#user-form-title').textContent = 'Add user';
  $('#user-cancel').classList.add('hidden');
  $('#user-depts').innerHTML = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]));
  $('#role-help').textContent = ROLE_HELP[f.role.value];
}
$('#user-form').role.addEventListener('change', (e) => { $('#role-help').textContent = ROLE_HELP[e.target.value]; });
$('#user-cancel').addEventListener('click', resetUserForm);

async function loadUsers() {
  await loadPeople();
  const f = $('#user-form');
  if (!f.id.value && !f.contains(document.activeElement)) {
    const html = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]));
    if ($('#user-depts').dataset.html !== html) { resetUserForm(); $('#user-depts').dataset.html = html; }
  }
  const users = await api('/users');
  $('#users').innerHTML = users.map((u) => `<tr>
    <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${esc(u.username)}</td>
    <td><span class="badge role-${u.role}">${u.role}</span></td>
    <td>${u.role === 'admin' ? '<span class="muted">All</span>' : (u.departmentIds || []).map((id) => `<span class="badge dept">${esc(deptName(id))}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${u.active ? '<span class="badge sent">active</span>' : '<span class="badge failed">disabled</span>'}</td>
    <td class="muted">${u.lastLoginAt ? fmt(u.lastLoginAt) : 'never'}</td>
    <td><button class="btn sm" data-edit="${u.id}">Edit</button>
      ${u.id !== me.id ? `<button class="btn sm" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Disable' : 'Enable'}</button>
      <button class="btn sm danger" data-del="${u.id}">Delete</button>` : ''}</td></tr>`).join('');
  $('#users').dataset.json = JSON.stringify(users);
}

$('#users').addEventListener('click', async (e) => {
  const { edit, toggle, active, del } = e.target.dataset;
  try {
    if (edit) {
      const u = JSON.parse($('#users').dataset.json).find((x) => x.id === edit);
      const f = $('#user-form');
      f.id.value = u.id;
      f.name.value = u.name;
      f.username.value = u.username;
      f.username.disabled = true;
      f.password.value = '';
      f.password.required = false;
      f.password.placeholder = 'New password (leave blank to keep)';
      f.role.value = u.role;
      $('#role-help').textContent = ROLE_HELP[u.role];
      $('#user-depts').innerHTML = checkboxes('departmentIds', departments.map((d) => [d.id, d.name]), u.departmentIds || []);
      $('#user-form-title').textContent = `Edit ${u.name}`;
      $('#user-cancel').classList.remove('hidden');
      f.scrollIntoView({ behavior: 'smooth' });
    }
    if (toggle) await api(`/users/${toggle}`, { method: 'PATCH', body: { active: active !== '1' } });
    if (del && confirm('Delete this user? Their tickets become unassigned.')) await api(`/users/${del}`, { method: 'DELETE' });
    if (toggle || del) loadUsers();
  } catch (err) { alert(err.message); }
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(), role: f.role.value,
    departmentIds: $$('#user-depts input:checked').map((x) => x.value),
  };
  if (f.password.value) body.password = f.password.value;
  try {
    if (f.id.value) await api(`/users/${f.id.value}`, { method: 'PATCH', body });
    else await api('/users', { method: 'POST', body: { ...body, username: f.username.value.trim() } });
    resetUserForm();
    loadUsers();
  } catch (err) { alert(err.message); }
});

/* ---------- Departments (admin) ---------- */
let sessionIds = [];
function resetDeptForm() {
  const f = $('#dept-form');
  f.reset();
  f.id.value = '';
  $('#dept-form-title').textContent = 'Add department';
  $('#dept-cancel').classList.add('hidden');
  $('#dept-sessions').innerHTML = checkboxes('sessionIds', sessionIds.map((s) => [s, s]));
}
$('#dept-cancel').addEventListener('click', resetDeptForm);

async function loadDepartments() {
  await loadPeople();
  if (me.role === 'admin') {
    sessionIds = (await api('/sessions')).map((s) => s.id);
    const f = $('#dept-form');
    if (!f.id.value && !f.contains(document.activeElement)) {
      const key = sessionIds.join(',');
      if ($('#dept-sessions').dataset.key !== key) { resetDeptForm(); $('#dept-sessions').dataset.key = key; }
    }
  }
  $('#departments').innerHTML = departments.map((d) => `<tr>
    <td><strong>${esc(d.name)}</strong>${d.isDefault ? ' <span class="badge">default</span>' : ''}<br><span class="muted">${esc(d.description || '')}</span></td>
    <td>${(d.sessionIds || []).map((s) => `<span class="badge">${esc(s)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${(d.keywords || []).map((k) => `<code>${esc(k)}</code>`).join(' ') || '<span class="muted">—</span>'}</td>
    <td>${d.members.map((m) => esc(m.name)).join(', ') || '<span class="muted">No members</span>'}</td>
    <td>${d.activeTickets}</td>
    <td>${d.autoAssign ? 'On' : 'Off'}</td>
    <td>${me.role === 'admin' ? `<button class="btn sm" data-edit="${d.id}">Edit</button> <button class="btn sm danger" data-del="${d.id}">Delete</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">No departments yet</td></tr>';
}

$('#departments').addEventListener('click', async (e) => {
  const { edit, del } = e.target.dataset;
  try {
    if (edit) {
      const d = departments.find((x) => x.id === edit);
      const f = $('#dept-form');
      f.id.value = d.id;
      f.name.value = d.name;
      f.description.value = d.description || '';
      f.keywords.value = (d.keywords || []).join(', ');
      f.autoAssign.checked = !!d.autoAssign;
      f.isDefault.checked = !!d.isDefault;
      $('#dept-sessions').innerHTML = checkboxes('sessionIds', [...new Set([...sessionIds, ...(d.sessionIds || [])])].map((s) => [s, s]), d.sessionIds || []);
      $('#dept-form-title').textContent = `Edit ${d.name}`;
      $('#dept-cancel').classList.remove('hidden');
      f.scrollIntoView({ behavior: 'smooth' });
    }
    if (del && confirm('Delete this department? Its tickets will have no department.')) {
      await api(`/departments/${del}`, { method: 'DELETE' });
      loadDepartments();
    }
  } catch (err) { alert(err.message); }
});

$('#dept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value, description: f.description.value, keywords: f.keywords.value,
    sessionIds: $$('#dept-sessions input:checked').map((x) => x.value),
    autoAssign: f.autoAssign.checked, isDefault: f.isDefault.checked,
  };
  try {
    if (f.id.value) await api(`/departments/${f.id.value}`, { method: 'PATCH', body });
    else await api('/departments', { method: 'POST', body });
    resetDeptForm();
    loadDepartments();
  } catch (err) { alert(err.message); }
});

/* ---------- Button builder (Send page + campaigns) ---------- */
const BUTTON_KINDS = {
  reply: { label: 'Quick reply', value: 'reply', hint: 'Automatic answer when tapped (optional)' },
  url: { label: 'Website link', value: 'url', hint: 'https://…' },
  call: { label: 'Call number', value: 'phone', hint: 'Phone with country code' },
  copy: { label: 'Copy code', value: 'code', hint: 'Coupon code, e.g. DIWALI30' },
};
const NUMS = ['1️⃣', '2️⃣', '3️⃣'];

function buttonBuilder(container, onChange = () => {}) {
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn sm';
  addBtn.textContent = '+ Add button';
  const rows = document.createElement('div');
  container.append(rows, addBtn);

  function addRow() {
    if (rows.children.length >= 3) return;
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.innerHTML = `
      <select class="b-type">${Object.entries(BUTTON_KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
      <input class="b-title" maxlength="20" placeholder="Button text (max 20)" />
      <input class="b-value" placeholder="${BUTTON_KINDS.reply.hint}" />
      <button type="button" class="btn sm danger b-remove" title="Remove">✕</button>`;
    row.querySelector('.b-type').addEventListener('change', (e) => {
      row.querySelector('.b-value').placeholder = BUTTON_KINDS[e.target.value].hint;
      onChange();
    });
    row.querySelector('.b-remove').addEventListener('click', () => { row.remove(); sync(); });
    row.addEventListener('input', onChange);
    rows.append(row);
    sync();
  }
  function sync() {
    addBtn.classList.toggle('hidden', rows.children.length >= 3);
    onChange();
  }
  addBtn.addEventListener('click', addRow);

  return {
    get() {
      return [...rows.children].map((row) => {
        const type = row.querySelector('.b-type').value;
        const title = row.querySelector('.b-title').value.trim();
        const value = row.querySelector('.b-value').value.trim();
        return title ? { type, title, [BUTTON_KINDS[type].value]: value } : null;
      }).filter(Boolean);
    },
    clear() { rows.innerHTML = ''; sync(); },
  };
}

// Text version of the options, matching what the server appends to the message.
function textOptions(buttons) {
  const lines = [];
  const replies = buttons.filter((b) => b.type === 'reply');
  if (replies.length) { lines.push('Reply with a number:'); replies.forEach((b, i) => lines.push(`${NUMS[i]} ${b.title}`)); }
  for (const b of buttons) {
    if (b.type === 'url') lines.push(`🔗 ${b.title}: ${b.url}`);
    if (b.type === 'call') lines.push(`📞 ${b.title}: +${String(b.phone || '').replace(/\D/g, '')}`);
    if (b.type === 'copy') lines.push(`🏷️ ${b.title}: ${b.code}`);
  }
  return lines.join('\n');
}

const sendButtons = buttonBuilder($('#send-buttons'), renderSendPreview);
const campaignButtons = buttonBuilder($('#campaign-buttons'));
let previewImageUrl = null;

function renderSendPreview() {
  const f = $('#send-form');
  const buttons = sendButtons.get();
  const file = f.file.files[0];
  f.footer.classList.toggle('hidden', !buttons.length);
  const text = f.text.value + (buttons.length ? `\n\n${textOptions(buttons)}` : '');
  const icon = { reply: '↩', url: '🔗', call: '📞', copy: '📋' };
  $('#send-preview').innerHTML = !text.trim() && !file ? '<p class="muted small">Type a message to see a preview.</p>' : `
    <div class="wa-bubble">
      ${file && previewImageUrl ? `<img src="${previewImageUrl}" alt="">` : file ? `<div class="wa-file">📎 ${esc(file.name)}</div>` : ''}
      ${text.trim() ? `<div class="wa-text">${esc(text)}</div>` : ''}
      ${buttons.length && f.footer.value ? `<div class="wa-footer">${esc(f.footer.value)}</div>` : ''}
    </div>
    ${buttons.map((b) => `<div class="wa-button">${icon[b.type]} ${esc(b.title)}</div>`).join('')}`;
}
$('#send-form').addEventListener('input', renderSendPreview);
$('#send-form').file.addEventListener('change', (e) => {
  if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
  const file = e.target.files[0];
  previewImageUrl = file?.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  renderSendPreview();
});
renderSendPreview();

/* ---------- Contact picker for the "To" field ---------- */
const toInput = $('#send-form').to;
const toList = $('#to-suggestions');
let toMatches = [];
let toActive = -1;
let toTimer;

function showSelectedContact(c) {
  $('#to-selected').innerHTML = c
    ? `✓ ${esc(c.name || 'Saved contact')}${c.tags?.length ? ` · ${c.tags.map(esc).join(', ')}` : ''}${c.optedOut ? ' · <span class="error">opted out</span>' : ''}`
    : '';
}
function closeSuggestions() {
  toList.classList.add('hidden');
  toInput.setAttribute('aria-expanded', 'false');
  toActive = -1;
}
function renderSuggestions() {
  toList.innerHTML = toMatches.length
    ? toMatches.map((c, i) => `
      <li role="option" data-i="${i}" class="${i === toActive ? 'active' : ''} ${c.optedOut ? 'disabled' : ''}" aria-selected="${i === toActive}">
        <span><strong>${esc(c.name || '+' + c.phone)}</strong>${c.name ? ` <span class="muted">+${esc(c.phone)}</span>` : ''}</span>
        <span class="tags">${c.optedOut ? '<span class="badge opted">opted out</span>' : ''}${(c.tags || []).slice(0, 3).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</span>
      </li>`).join('')
    : '<li class="empty">No saved contacts match. You can still send to a typed number.</li>';
  toList.classList.remove('hidden');
  toInput.setAttribute('aria-expanded', 'true');
  toList.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
}
async function searchContacts() {
  const q = toInput.value.trim();
  const list = await api(`/contacts?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`).catch(() => []);
  if (toInput.value.trim() !== q) return; // a newer search is on its way
  // active contacts first, then by name, unnamed last
  toMatches = list.sort((a, b) => (!!a.optedOut - !!b.optedOut) || (!a.name - !b.name) ||
    (a.name || a.phone).localeCompare(b.name || b.phone));
  toActive = -1;
  const digits = q.replace(/\D/g, '');
  showSelectedContact(digits && list.find((c) => c.phone === digits));
  if (document.activeElement === toInput) renderSuggestions();
}
function pickContact(i) {
  const c = toMatches[i];
  if (!c || c.optedOut) return;
  toInput.value = c.phone;
  showSelectedContact(c);
  closeSuggestions();
}

toInput.addEventListener('focus', searchContacts);
toInput.addEventListener('input', () => {
  showSelectedContact(null);
  clearTimeout(toTimer);
  toTimer = setTimeout(searchContacts, 200);
});
toInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
toInput.addEventListener('keydown', (e) => {
  const open = !toList.classList.contains('hidden');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return searchContacts();
    if (!toMatches.length) return;
    toActive = (toActive + (e.key === 'ArrowDown' ? 1 : -1) + toMatches.length) % toMatches.length;
    renderSuggestions();
  } else if (e.key === 'Enter' && open && toActive >= 0) {
    e.preventDefault(); // pick the contact instead of submitting the form
    pickContact(toActive);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeSuggestions();
  }
});
// mousedown (not click) so the input doesn't lose focus first
toList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  e.preventDefault();
  if (li) pickContact(Number(li.dataset.i));
});

/* ---------- Send ---------- */
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('#send-result');
  out.textContent = 'Sending…';
  try {
    const file = f.file.files[0];
    const buttons = sendButtons.get();
    if (buttons.length) {
      if (!f.text.value.trim()) throw new Error('A message is required when sending buttons');
      if (file && !file.type.startsWith('image/')) throw new Error('With buttons, the attachment must be an image');
      const fd = new FormData();
      fd.append('sessionId', f.sessionId.value); fd.append('to', f.to.value); fd.append('text', f.text.value);
      fd.append('footer', f.footer.value); fd.append('buttons', JSON.stringify(buttons));
      if (file) fd.append('image', file);
      await api('/messages/buttons', { method: 'POST', form: fd });
    } else if (file) {
      const fd = new FormData();
      fd.append('sessionId', f.sessionId.value); fd.append('to', f.to.value); fd.append('caption', f.text.value); fd.append('file', file);
      await api('/messages/media', { method: 'POST', form: fd });
    } else {
      if (!f.text.value.trim()) throw new Error('Enter a message or attach a file');
      await api('/messages/text', { method: 'POST', body: { sessionId: f.sessionId.value, to: f.to.value, text: f.text.value } });
    }
    out.innerHTML = '<span class="badge sent">Sent</span>';
    f.text.value = ''; f.file.value = ''; f.footer.value = '';
    sendButtons.clear();
    previewImageUrl = null;
    renderSendPreview();
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
      buttons: campaignButtons.get(), footer: f.footer.value,
    } });
    alert(`Campaign created for ${c.stats.total} recipients`);
    f.reset(); campaignButtons.clear(); loadCampaigns();
  } catch (err) { alert(err.message); }
});
async function loadCampaigns() {
  const list = await api('/campaigns');
  $('#campaigns').innerHTML = list.map((c) => {
    const done = c.stats.sent + c.stats.failed + c.stats.skipped;
    const pct = c.stats.total ? Math.round((done / c.stats.total) * 100) : 0;
    return `<tr><td>${esc(c.name)}<br><span class="muted">${fmt(c.createdAt)}</span></td><td>${esc(c.sessionId)}</td>
      <td><span class="badge ${esc(c.status)}">${esc(CAMPAIGN_STATUS[c.status] || c.status)}</span>
        ${c.pauseReason ? `<div class="pause-reason">${esc(c.pauseReason)}</div>` : ''}</td>
      <td>${c.stats.sent} sent · ${c.stats.failed} failed · ${c.stats.skipped} skipped / ${c.stats.total}
        <div class="progress"><div style="width:${pct}%"></div></div></td>
      <td>${c.status === 'running' || c.status === 'waiting_quiet'
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
