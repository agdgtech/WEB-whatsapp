// Manages multiple WhatsApp Web sessions (one per business number) via QR login.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import { db, save, uid, now, normalizePhone } from './store.js';
import { emitWebhook } from './webhook.js';

const SESSIONS_DIR = path.resolve('sessions');
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'cancel'];
const logger = pino({ level: 'warn' });

const sessions = new Map(); // id -> { id, sock, status, qr, qrDataUrl, user, retries }

export const toJid = (phone) => `${normalizePhone(phone)}@s.whatsapp.net`;

export function listSessions() {
  return [...sessions.values()].map(publicView);
}

export function getSession(id) {
  return sessions.get(id);
}

function publicView(s) {
  return {
    id: s.id,
    status: s.status, // starting | qr | connected | disconnected | logged_out
    user: s.user || null,
    hasQr: !!s.qrDataUrl,
  };
}

export async function startSession(id) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('Session id must be 1-40 chars: letters, digits, _ or -');
  const existing = sessions.get(id);
  if (existing && ['connected', 'qr', 'starting'].includes(existing.status)) return publicView(existing);

  const state = existing || { id, retries: 0 };
  state.status = 'starting';
  sessions.set(id, state);

  const authDir = path.join(SESSIONS_DIR, id);
  const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth,
    logger,
    browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  state.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      state.status = 'qr';
      state.qr = qr;
      state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
    }
    if (connection === 'open') {
      state.status = 'connected';
      state.qr = state.qrDataUrl = null;
      state.retries = 0;
      state.user = { id: sock.user?.id, name: sock.user?.name };
      emitWebhook('session.connected', { sessionId: id, user: state.user });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.qr = state.qrDataUrl = null;
      if (code === DisconnectReason.loggedOut) {
        state.status = 'logged_out';
        fs.rmSync(authDir, { recursive: true, force: true });
        emitWebhook('session.logged_out', { sessionId: id });
        return;
      }
      if (state.stopped) {
        state.status = 'disconnected';
        return;
      }
      state.status = 'disconnected';
      state.retries++;
      const delay = Math.min(30000, 2000 * state.retries);
      setTimeout(() => startSession(id).catch((e) => logger.error(e)), delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue;
      const jid = m.key.remoteJidAlt || m.key.remoteJid || '';
      if (!jid.endsWith('@s.whatsapp.net')) continue; // ignore groups, broadcasts, LID-only senders
      const phone = jid.split('@')[0];
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        '';
      db.messages.push({
        id: uid(), sessionId: id, to: phone, text, status: 'received', direction: 'in', createdAt: now(),
      });
      handleOptOut(id, phone, text);
      save();
      emitWebhook('message.received', { sessionId: id, from: phone, text, pushName: m.pushName, raw: m });
    }
  });

  return publicView(state);
}

function handleOptOut(sessionId, phone, text) {
  const t = text.trim().toLowerCase();
  if (!OPT_OUT_WORDS.includes(t)) return;
  let c = db.contacts.find((x) => x.phone === phone);
  if (!c) {
    c = { id: uid(), phone, name: '', tags: [], createdAt: now() };
    db.contacts.push(c);
  }
  c.optedOut = true;
  emitWebhook('contact.opted_out', { sessionId, phone });
  sendText(sessionId, phone, 'You have been unsubscribed and will not receive further messages.').catch(() => {});
}

export async function stopSession(id, { logout = false } = {}) {
  const s = sessions.get(id);
  if (!s) throw new Error('Session not found');
  s.stopped = true;
  if (logout) {
    await s.sock?.logout().catch(() => {});
    fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  } else {
    s.sock?.end(undefined);
  }
  sessions.delete(id);
}

function requireConnected(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== 'connected') throw new Error(`Session "${sessionId}" is not connected`);
  return s.sock;
}

export async function isOnWhatsApp(sessionId, phone) {
  const sock = requireConnected(sessionId);
  const [res] = (await sock.onWhatsApp(normalizePhone(phone))) || [];
  return !!res?.exists;
}

export async function sendText(sessionId, phone, text) {
  const sock = requireConnected(sessionId);
  return sock.sendMessage(toJid(phone), { text });
}

// media: { url } or { buffer }, plus mimetype / fileName
export async function sendMedia(sessionId, phone, { url, buffer, mimetype = '', fileName, caption }) {
  const sock = requireConnected(sessionId);
  const src = buffer || { url };
  let content;
  if (mimetype.startsWith('image/') || (!mimetype && /\.(png|jpe?g|webp)$/i.test(url || ''))) {
    content = { image: src, caption };
  } else if (mimetype.startsWith('video/') || (!mimetype && /\.mp4$/i.test(url || ''))) {
    content = { video: src, caption };
  } else if (mimetype.startsWith('audio/')) {
    content = { audio: src, mimetype };
  } else {
    content = { document: src, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'file', caption };
  }
  return sock.sendMessage(toJid(phone), content);
}

// Restore every session that has saved credentials on disk.
export async function restoreSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    if (fs.existsSync(path.join(SESSIONS_DIR, dir, 'creds.json'))) {
      await startSession(dir).catch((e) => console.error(`Restore ${dir} failed:`, e.message));
    }
  }
}
