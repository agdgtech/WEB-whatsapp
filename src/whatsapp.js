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
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { db, save, uid, now, normalizePhone } from './store.js';
import { emitWebhook } from './webhook.js';
import { handleIncoming } from './tickets.js';
import { textOptions, nativeFlowButtons, rememberMenu, resolveChoice } from './buttons.js';
import { sessionMeta } from './health.js';

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
      sessionMeta(id); // remembers when we first saw this number (used for warm-up)
      save();
      emitWebhook('session.connected', { sessionId: id, user: state.user });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.qr = state.qrDataUrl = null;
      // unexpected logouts/drops feed the block-risk analysis (normal restarts and our own unlink don't count)
      if (!state.stopped && code !== DisconnectReason.restartRequired) {
        recordSessionEvent(id, code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', code);
      }
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
      const msg = normalizeMessageContent(m.message);
      const { text: raw, buttonId } = buttonReply(msg) || { text: messageText(msg) };
      if (!raw) continue; // reactions, receipts, protocol messages

      // a tap on one of our buttons, or a typed menu number ("1")
      const choice = resolveChoice(id, phone, { buttonId, text: raw });
      const text = choice ? (buttonId ? `[button] ${choice.title}` : `${raw} → ${choice.title}`) : raw;

      db.messages.push({
        id: uid(), sessionId: id, to: phone, text, status: 'received', direction: 'in', createdAt: now(),
        ...(choice ? { buttonId: choice.id } : {}),
      });
      handleOptOut(id, phone, raw);
      save();
      emitWebhook('message.received', {
        sessionId: id, from: phone, text, pushName: m.pushName,
        button: choice ? { id: choice.id, title: choice.title } : null, raw: m,
      });
      handleIncoming(id, phone, text, m.pushName, { autoReply: choice?.reply })
        .catch((e) => console.error('Ticket error:', e.message));
    }
  });

  return publicView(state);
}

// Responses to button messages, in the formats different WhatsApp versions use.
function buttonReply(msg) {
  const nf = msg.interactiveResponseMessage;
  if (nf) {
    let params = {};
    try { params = JSON.parse(nf.nativeFlowResponseMessage?.paramsJson || '{}'); } catch {}
    return { text: nf.body?.text || params.display_text || '', buttonId: params.id };
  }
  if (msg.buttonsResponseMessage) {
    return { text: msg.buttonsResponseMessage.selectedDisplayText, buttonId: msg.buttonsResponseMessage.selectedButtonId };
  }
  if (msg.templateButtonReplyMessage) {
    return { text: msg.templateButtonReplyMessage.selectedDisplayText, buttonId: msg.templateButtonReplyMessage.selectedId };
  }
  return null;
}

function messageText(msg) {
  const caption = (x, label) => (x ? `[${label}]${x.caption ? ' ' + x.caption : ''}` : '');
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    caption(msg.imageMessage, 'image') ||
    caption(msg.videoMessage, 'video') ||
    (msg.documentMessage ? `[document] ${msg.documentMessage.fileName || ''}`.trim() : '') ||
    (msg.audioMessage ? '[voice note]' : '') ||
    (msg.stickerMessage ? '[sticker]' : '') ||
    (msg.locationMessage ? `[location] ${msg.locationMessage.degreesLatitude},${msg.locationMessage.degreesLongitude}` : '') ||
    (msg.contactMessage ? `[contact] ${msg.contactMessage.displayName || ''}`.trim() : '') ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    ''
  );
}

function recordSessionEvent(id, type, code) {
  const meta = sessionMeta(id);
  meta.events = [...(meta.events || []), { type, code, at: now() }].slice(-100);
  save();
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
  c.optedOutAt = now();
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

// Tells WhatsApp servers this is an interactive (native flow) message; without it buttons are dropped.
const BIZ_NODE = {
  tag: 'biz',
  attrs: {},
  content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }],
};

// Image (optional) + text + up to 3 buttons. `buttons` must already be validated (see buttons.js).
// image: { url } or { buffer }. The options are also written into the text so the message still
// works on phones that don't display buttons.
export async function sendButtons(sessionId, phone, { text, footer, image, buttons, campaignId, includeTextOptions = true }) {
  const sock = requireConnected(sessionId);
  const jid = toJid(phone);
  const body = includeTextOptions ? `${text}\n\n${textOptions(buttons)}` : text;

  const header = { title: '', subtitle: '', hasMediaAttachment: false };
  if (image) {
    const media = await prepareWAMessageMedia(
      { image: image.buffer || { url: image.url } },
      { upload: sock.waUploadToServer, logger },
    );
    header.hasMediaAttachment = true;
    header.imageMessage = media.imageMessage;
  }

  const content = proto.Message.fromObject({
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          header,
          body: { text: body },
          footer: { text: footer || '' },
          nativeFlowMessage: { buttons: nativeFlowButtons(buttons), messageParamsJson: '' },
        },
      },
    },
  });
  const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [BIZ_NODE] });
  rememberMenu(sessionId, normalizePhone(phone), buttons, campaignId);
  return msg;
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
