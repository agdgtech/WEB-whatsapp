// Users, logins and permissions. Dashboard users sign in with username/password (Bearer token);
// integrations use API keys (x-api-key), which act with admin rights.
import crypto from 'node:crypto';
import { db, save, uid, now } from './store.js';

export const ROLES = ['admin', 'manager', 'agent'];
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  return safeEqual(crypto.scryptSync(String(pw), salt, 64).toString('hex'), hash);
}

export const publicUser = ({ passwordHash, ...u }) => u;

// First start: create the admin account from ADMIN_USER / ADMIN_PASSWORD in .env
export function ensureAdminUser() {
  if (db.users.length) return;
  db.users.push({
    id: uid(),
    username: (process.env.ADMIN_USER || 'admin').toLowerCase(),
    name: 'Administrator',
    role: 'admin',
    departmentIds: [],
    active: true,
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'change-me'),
    createdAt: now(),
  });
  save();
}

export function validatePassword(pw) {
  if (String(pw || '').length < 8) throw new Error('Password must be at least 8 characters');
}

export function login(username, password) {
  const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase());
  // Always run scrypt so response time doesn't reveal whether the username exists.
  const ok = verifyPassword(password, u?.passwordHash || 'scrypt$00$00');
  if (!u || !ok || !u.active) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.authTokens = db.authTokens.filter((t) => t.exp > Date.now());
  db.authTokens.push({ hash: sha256(token), userId: u.id, exp: Date.now() + TOKEN_TTL_MS });
  u.lastLoginAt = now();
  save();
  return { token, user: publicUser(u) };
}

export function logout(token) {
  const hash = sha256(token);
  db.authTokens = db.authTokens.filter((t) => t.hash !== hash);
  save();
}

export function revokeUserTokens(userId) {
  db.authTokens = db.authTokens.filter((t) => t.userId !== userId);
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

function userFromRequest(req) {
  const token = bearer(req);
  if (token) {
    const hash = sha256(token);
    const t = db.authTokens.find((x) => x.hash === hash && x.exp > Date.now());
    const u = t && db.users.find((x) => x.id === t.userId && x.active);
    if (u) return publicUser(u);
  }
  const key = req.headers['x-api-key'];
  const k = key && db.apiKeys.find((x) => safeEqual(x.key, key));
  if (k) return { id: `api:${k.id}`, name: `API: ${k.name}`, role: 'admin', departmentIds: [], apiKey: true };
  return null;
}

export function requireAuth(req, res, next) {
  req.user = userFromRequest(req);
  if (req.user) return next();
  res.status(401).json({ error: 'Unauthorized: send "Authorization: Bearer <token>" or "x-api-key: <key>"' });
}

// Use after requireAuth.
export const requireRole = (...roles) => (req, res, next) => {
  if (roles.includes(req.user?.role)) return next();
  res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
};

// Dashboard admin signed in as a person (not an API key), e.g. for managing API keys.
export function requireAdminUser(req, res, next) {
  if (req.user?.role === 'admin' && !req.user.apiKey) return next();
  res.status(403).json({ error: 'Admin login required' });
}

export const newApiKey = () => 'wak_' + crypto.randomBytes(24).toString('hex');
