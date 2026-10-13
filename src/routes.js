import { Router } from 'express';
import multer from 'multer';
import { db, save, uid, now, normalizePhone, logMessage } from './store.js';
import { login, logout, requireAuth, requireAdmin, newApiKey } from './auth.js';
import {
  listSessions, getSession, startSession, stopSession, sendText, sendMedia, isOnWhatsApp,
} from './whatsapp.js';
import { createCampaign, startCampaign, pauseCampaign } from './campaigns.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const r = Router();

// Wrap async handlers so thrown errors become 400 JSON responses.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

/* ---------- Auth ---------- */
r.post('/auth/login', h((req) => {
  const token = login(req.body?.username, req.body?.password);
  if (!token) throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  return { token };
}));
r.post('/auth/logout', requireAdmin, h((req) => {
  logout((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
}));

/* ---------- API keys (admin only) ---------- */
r.get('/keys', requireAdmin, h(() => db.apiKeys.map((k) => ({ ...k, key: k.key.slice(0, 10) + '…' }))));
r.post('/keys', requireAdmin, h((req) => {
  const k = { id: uid(), name: req.body?.name || 'API key', key: newApiKey(), createdAt: now() };
  db.apiKeys.push(k);
  save();
  return k; // full key shown only once
}));
r.delete('/keys/:id', requireAdmin, h((req) => {
  db.apiKeys = db.apiKeys.filter((k) => k.id !== req.params.id);
  save();
}));

/* Everything below accepts admin token OR API key */
r.use(requireAuth);

/* ---------- Sessions (WhatsApp numbers) ---------- */
r.get('/sessions', h(() => listSessions()));
r.post('/sessions', h((req) => startSession(String(req.body?.id || '').trim())));
r.get('/sessions/:id', h((req) => {
  const s = getSession(req.params.id);
  if (!s) throw notFound('Session');
  return { id: s.id, status: s.status, user: s.user || null, qr: s.qrDataUrl || null };
}));
r.get('/sessions/:id/qr', h((req, res) => {
  const s = getSession(req.params.id);
  if (!s) throw notFound('Session');
  if (!s.qrDataUrl) return { status: s.status, qr: null };
  if (req.query.format === 'image') {
    res.type('png').send(Buffer.from(s.qrDataUrl.split(',')[1], 'base64'));
    return;
  }
  return { status: s.status, qr: s.qrDataUrl };
}));
r.delete('/sessions/:id', h((req) => stopSession(req.params.id, { logout: req.query.logout === 'true' })));

/* ---------- Messaging ---------- */
r.get('/check/:sessionId/:phone', h(async (req) => ({
  phone: normalizePhone(req.params.phone),
  exists: await isOnWhatsApp(req.params.sessionId, req.params.phone),
})));

r.post('/messages/text', h(async (req) => {
  const { sessionId, to, text } = req.body || {};
  if (!sessionId || !to || !text) throw new Error('sessionId, to and text are required');
  const phone = normalizePhone(to);
  if (db.contacts.find((c) => c.phone === phone)?.optedOut) throw new Error('Contact has opted out');
  try {
    const res = await sendText(sessionId, phone, text);
    logMessage({ sessionId, to: phone, text, status: 'sent', waId: res?.key?.id });
    return { ok: true, messageId: res?.key?.id };
  } catch (e) {
    logMessage({ sessionId, to: phone, text, status: 'failed', error: e.message });
    throw e;
  }
}));

// JSON body with mediaUrl, or multipart/form-data with a "file" field
r.post('/messages/media', upload.single('file'), h(async (req) => {
  const { sessionId, to, caption, mediaUrl, mimetype, fileName } = req.body || {};
  if (!sessionId || !to || (!mediaUrl && !req.file)) throw new Error('sessionId, to and mediaUrl or file are required');
  const phone = normalizePhone(to);
  if (db.contacts.find((c) => c.phone === phone)?.optedOut) throw new Error('Contact has opted out');
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, fileName: req.file.originalname, caption }
    : { url: mediaUrl, mimetype, fileName, caption };
  try {
    const res = await sendMedia(sessionId, phone, media);
    logMessage({ sessionId, to: phone, text: caption || `[media] ${media.fileName || mediaUrl}`, status: 'sent', waId: res?.key?.id });
    return { ok: true, messageId: res?.key?.id };
  } catch (e) {
    logMessage({ sessionId, to: phone, text: caption || '[media]', status: 'failed', error: e.message });
    throw e;
  }
}));

r.get('/messages', h((req) => {
  const { sessionId, campaignId, direction, status, q, from, to, limit = 200 } = req.query;
  const search = String(q || '').toLowerCase();
  const fromTs = from ? new Date(from).getTime() : null;
  const toTs = to ? new Date(to).getTime() : null;
  const matches = db.messages.filter((m) => {
    const ts = new Date(m.createdAt).getTime();
    return (!sessionId || m.sessionId === sessionId) &&
      (!campaignId || m.campaignId === campaignId) &&
      (!direction || m.direction === direction) &&
      (!status || m.status === status) &&
      (!fromTs || ts >= fromTs) &&
      (!toTs || ts <= toTs) &&
      (!search || m.to?.includes(search) || m.text?.toLowerCase().includes(search));
  });
  return { total: matches.length, messages: matches.slice(-Number(limit)).reverse() };
}));

/* ---------- Contacts ---------- */
function upsertContact({ phone, name, tags }) {
  phone = normalizePhone(phone);
  if (phone.length < 8) return null;
  const tagList = (Array.isArray(tags) ? tags : String(tags || '').split(/[;,|]/))
    .map((t) => t.trim()).filter(Boolean);
  let c = db.contacts.find((x) => x.phone === phone);
  if (c) {
    if (name) c.name = name;
    c.tags = [...new Set([...(c.tags || []), ...tagList])];
  } else {
    c = { id: uid(), phone, name: name || '', tags: tagList, optedOut: false, createdAt: now() };
    db.contacts.push(c);
  }
  return c;
}

r.get('/contacts', h((req) => {
  const { tag, q } = req.query;
  return db.contacts.filter((c) =>
    (!tag || c.tags?.includes(tag)) &&
    (!q || c.phone.includes(q) || c.name?.toLowerCase().includes(String(q).toLowerCase())));
}));
r.post('/contacts', h((req) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const saved = items.map(upsertContact).filter(Boolean);
  save();
  return { saved: saved.length, contacts: saved };
}));

// CSV columns: phone,name,tags  (header row required; tags separated by ; or |)
r.post('/contacts/import', upload.single('file'), h((req) => {
  const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body?.csv || '');
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CSV is empty');
  const header = rows.shift().map((x) => x.trim().toLowerCase());
  const idx = (k) => header.indexOf(k);
  if (idx('phone') < 0) throw new Error('CSV needs a "phone" column');
  const extraTags = req.body?.tags || '';
  let saved = 0;
  for (const row of rows) {
    const tags = [row[idx('tags')] || '', extraTags].join(';');
    if (upsertContact({ phone: row[idx('phone')], name: row[idx('name')] || '', tags })) saved++;
  }
  save();
  return { imported: saved, skipped: rows.length - saved };
}));
r.patch('/contacts/:id', h((req) => {
  const c = db.contacts.find((x) => x.id === req.params.id);
  if (!c) throw notFound('Contact');
  for (const k of ['name', 'tags', 'optedOut']) if (k in req.body) c[k] = req.body[k];
  save();
  return c;
}));
r.delete('/contacts/:id', h((req) => {
  db.contacts = db.contacts.filter((c) => c.id !== req.params.id);
  save();
}));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/* ---------- Campaigns ---------- */
const summary = ({ recipients, ...c }) => c;
r.get('/campaigns', h(() => db.campaigns.map(summary).reverse()));
r.get('/campaigns/:id', h((req) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (!c) throw notFound('Campaign');
  return c;
}));
r.post('/campaigns', h((req) => {
  const b = req.body || {};
  const c = createCampaign({
    ...b,
    tags: Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    phones: (Array.isArray(b.phones) ? b.phones : []).map(normalizePhone),
  });
  if (b.startNow) startCampaign(c.id);
  return summary(c);
}));
r.post('/campaigns/:id/start', h((req) => summary(startCampaign(req.params.id))));
r.post('/campaigns/:id/pause', h((req) => summary(pauseCampaign(req.params.id))));
r.delete('/campaigns/:id', h((req) => {
  const c = db.campaigns.find((x) => x.id === req.params.id);
  if (c?.status === 'running') pauseCampaign(c.id);
  db.campaigns = db.campaigns.filter((x) => x.id !== req.params.id);
  save();
}));

/* ---------- Stats ---------- */
r.get('/stats', h(() => {
  const today = new Date().toISOString().slice(0, 10);
  const todays = db.messages.filter((m) => m.createdAt.startsWith(today));
  return {
    sessions: listSessions().length,
    connected: listSessions().filter((s) => s.status === 'connected').length,
    contacts: db.contacts.length,
    optedOut: db.contacts.filter((c) => c.optedOut).length,
    campaigns: db.campaigns.length,
    sentToday: todays.filter((m) => m.status === 'sent').length,
    failedToday: todays.filter((m) => m.status === 'failed').length,
    receivedToday: todays.filter((m) => m.direction === 'in').length,
  };
}));

export default r;
