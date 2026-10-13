// Bulk campaign runner: throttled, personalised, respects opt-outs and daily limits.
import { db, save, uid, now, logMessage, bumpDaily, dailyCount } from './store.js';
import { sendText, sendMedia, isOnWhatsApp, getSession } from './whatsapp.js';
import { emitWebhook } from './webhook.js';

const running = new Map(); // campaignId -> { cancel: bool }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// {{name}}, {{phone}} and spintax {Hi|Hello|Hey}
export function renderTemplate(tpl, contact) {
  return tpl
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name || 'there')
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone)
    .replace(/\{([^{}]+\|[^{}]+)\}/g, (_, opts) => {
      const parts = opts.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
}

export function createCampaign({ name, sessionId, message, mediaUrl, tags = [], phones = [] }) {
  if (!name || !sessionId || !message) throw new Error('name, sessionId and message are required');
  const audience = resolveAudience(tags, phones);
  const c = {
    id: uid(),
    name,
    sessionId,
    message,
    mediaUrl: mediaUrl || null,
    tags,
    recipients: audience.map((x) => ({ phone: x.phone, name: x.name || '', status: 'pending' })),
    status: 'draft', // draft | running | paused | completed | stopped_limit
    stats: { total: audience.length, sent: 0, failed: 0, skipped: 0 },
    createdAt: now(),
  };
  db.campaigns.push(c);
  save();
  return c;
}

function resolveAudience(tags, phones) {
  const optedOut = new Set(db.contacts.filter((c) => c.optedOut).map((c) => c.phone));
  let list = phones.length
    ? phones.map((p) => db.contacts.find((c) => c.phone === p) || { phone: p, name: '' })
    : db.contacts.filter((c) => !tags.length || c.tags?.some((t) => tags.includes(t)));
  const seen = new Set();
  return list.filter((c) => c.phone && !optedOut.has(c.phone) && !seen.has(c.phone) && seen.add(c.phone));
}

export function startCampaign(id) {
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campaign not found');
  if (running.has(id)) return c;
  if (getSession(c.sessionId)?.status !== 'connected') throw new Error(`Session "${c.sessionId}" is not connected`);
  c.status = 'running';
  save();
  const ctl = { cancel: false };
  running.set(id, ctl);
  run(c, ctl).finally(() => running.delete(id));
  return c;
}

export function pauseCampaign(id) {
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('Campaign not found');
  const ctl = running.get(id);
  if (ctl) ctl.cancel = true;
  c.status = 'paused';
  save();
  return c;
}

async function run(c, ctl) {
  const min = Number(process.env.MIN_DELAY_MS || 8000);
  const max = Number(process.env.MAX_DELAY_MS || 20000);
  const limit = Number(process.env.DAILY_LIMIT_PER_SESSION || 500);

  for (const r of c.recipients) {
    if (ctl.cancel) return;
    if (r.status !== 'pending') continue;

    if (dailyCount(c.sessionId) >= limit) {
      c.status = 'stopped_limit';
      save();
      return;
    }
    const contact = db.contacts.find((x) => x.phone === r.phone);
    if (contact?.optedOut) {
      r.status = 'skipped';
      c.stats.skipped++;
      save();
      continue;
    }

    try {
      if (!(await isOnWhatsApp(c.sessionId, r.phone))) {
        r.status = 'skipped';
        r.error = 'Not on WhatsApp';
        c.stats.skipped++;
        save();
        continue;
      }
      const text = renderTemplate(c.message, contact || r);
      if (c.mediaUrl) await sendMedia(c.sessionId, r.phone, { url: c.mediaUrl, caption: text });
      else await sendText(c.sessionId, r.phone, text);
      r.status = 'sent';
      c.stats.sent++;
      bumpDaily(c.sessionId);
      logMessage({ sessionId: c.sessionId, to: r.phone, text, status: 'sent', campaignId: c.id });
    } catch (e) {
      r.status = 'failed';
      r.error = e.message;
      c.stats.failed++;
      logMessage({ sessionId: c.sessionId, to: r.phone, text: c.message, status: 'failed', error: e.message, campaignId: c.id });
      if (/not connected/i.test(e.message)) {
        r.status = 'pending'; // retry this one on resume
        c.stats.failed--;
        c.status = 'paused';
        save();
        return;
      }
    }
    save();
    await sleep(rand(min, max));
  }
  c.status = 'completed';
  save();
  emitWebhook('campaign.completed', { campaignId: c.id, stats: c.stats });
}

// Campaigns that were running when the server stopped are marked paused; resume them from the dashboard.
export function pauseInterruptedCampaigns() {
  for (const c of db.campaigns.filter((x) => x.status === 'running')) {
    c.status = 'paused';
  }
  save();
}
