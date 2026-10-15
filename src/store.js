// Tiny JSON-file database. Good for a single server; swap for SQL/Mongo when you scale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({
  apiKeys: [],     // { id, name, key, createdAt }
  contacts: [],    // { id, phone, name, tags[], optedOut, createdAt }
  campaigns: [],   // { id, name, sessionId, message, mediaUrl, tags[], status, stats, createdAt }
  messages: [],    // { id, sessionId, to, text, status, error, campaignId, direction, createdAt }
  dailyCounts: {}, // { "<sessionId>:<YYYY-MM-DD>": n }
  tickets: [],     // see src/tickets.js
  ticketSeq: 1000, // last ticket number issued
  users: [],       // { id, username, name, role, departmentIds[], active, passwordHash, createdAt }
  departments: [], // { id, name, description, sessionIds[], keywords[], autoAssign, isDefault, createdAt }
  authTokens: [],  // { hash, userId, exp } — dashboard logins
  menus: {},       // "<sessionId>:<phone>" -> last button menu sent { buttons, campaignId, sentAt }
  settings: null,  // anti-block protection settings (src/settings.js)
  sessionMeta: {}, // sessionId -> { firstSeenAt, numberSince, events: [{ type, at }] }
});

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = fs.existsSync(DB_FILE)
  ? { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  : empty();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // keep the log bounded
    if (db.messages.length > 20000) db.messages = db.messages.slice(-20000);
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export function normalizePhone(input) {
  return String(input || '').replace(/\D/g, '');
}

export function logMessage(entry) {
  const msg = { id: uid(), createdAt: now(), direction: 'out', ...entry };
  db.messages.push(msg);
  save();
  return msg;
}

export function bumpDaily(sessionId) {
  const key = `${sessionId}:${new Date().toISOString().slice(0, 10)}`;
  db.dailyCounts[key] = (db.dailyCounts[key] || 0) + 1;
  save();
  return db.dailyCounts[key];
}

export function dailyCount(sessionId) {
  return db.dailyCounts[`${sessionId}:${new Date().toISOString().slice(0, 10)}`] || 0;
}
