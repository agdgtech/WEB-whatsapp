// Two ways in: dashboard admin token (Bearer) or an API key (x-api-key header).
import crypto from 'node:crypto';
import { db } from './store.js';

const adminTokens = new Map(); // token -> expiresAt
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function login(username, password) {
  const ok = safeEqual(username, process.env.ADMIN_USER || 'admin') &&
    safeEqual(password, process.env.ADMIN_PASSWORD || 'change-me');
  if (!ok) return null;
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function logout(token) {
  adminTokens.delete(token);
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = token && adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

// Admin token or API key
export function requireAuth(req, res, next) {
  if (isAdmin(req)) return next();
  const key = req.headers['x-api-key'];
  if (key && db.apiKeys.some((k) => safeEqual(k.key, key))) return next();
  res.status(401).json({ error: 'Unauthorized: send "Authorization: Bearer <token>" or "x-api-key: <key>"' });
}

// Dashboard admin only (e.g. managing API keys)
export function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Admin login required' });
}

export const newApiKey = () => 'wak_' + crypto.randomBytes(24).toString('hex');
