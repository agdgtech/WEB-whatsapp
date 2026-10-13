# WA Marketing

Self-hosted WhatsApp marketing platform with its own REST API. Numbers are linked by scanning a
WhatsApp Web QR code (no Meta Business API account needed). Built on Node.js, Express and
[Baileys](https://github.com/WhiskeySockets/Baileys).

## Features

- **Multiple WhatsApp numbers**: link each one by QR, auto-reconnect, sessions survive restarts
- **Own REST API** with API keys (`x-api-key`) for CRMs, websites, ERPs
- **Send** text, images, videos, documents (by URL or upload)
- **Contacts** with tags, CSV import, opt-out tracking
- **Campaigns**: bulk sends by tag or phone list, `{{name}}` personalisation, `{Hi|Hello}` spintax,
  random delays, daily per-number cap, pause/resume, skips numbers not on WhatsApp
- **Auto opt-out**: replies of `STOP` / `UNSUBSCRIBE` mark the contact opted out
- **Webhooks** for incoming messages, connection events, opt-outs and campaign completion
- **Dashboard**: stats, QR linking, send, contacts, campaigns, logs, API keys, API docs

## Quick start

```bash
npm install
cp .env.example .env      # then set ADMIN_PASSWORD
npm start
```

Open http://localhost:3000, sign in, go to **WhatsApp Numbers**, add a session (e.g. `sales-1`)
and scan the QR from your phone: WhatsApp → Settings → Linked devices → Link a device.

Then create an API key under **API Keys**. Full endpoint list is in the **API Docs** tab.

```bash
curl -X POST http://localhost:3000/api/messages/text \
  -H "x-api-key: wak_..." -H "Content-Type: application/json" \
  -d '{"sessionId":"sales-1","to":"919876543210","text":"Hello from API"}'
```

## Project layout

```
server.js            Express app, startup
src/whatsapp.js      QR login, sessions, send, incoming messages, opt-out
src/campaigns.js     Bulk campaign runner (throttling, templates, daily limit)
src/routes.js        REST API
src/auth.js          Admin login + API keys
src/store.js         JSON-file database (data/db.json)
src/webhook.js       Outgoing webhooks
public/              Dashboard (HTML/CSS/JS)
sessions/            WhatsApp login credentials (keep private, never commit)
```

## Important: account safety and compliance

This uses the **unofficial** WhatsApp Web protocol. WhatsApp's Terms of Service do not allow
automated or bulk messaging from unofficial clients, and numbers that send unsolicited bulk messages
get **banned**. To reduce risk:

- Message only people who **opted in**, and always include "Reply STOP to unsubscribe".
- Keep the default delays (8–20 s) and daily cap; warm up new numbers slowly (e.g. 20–50/day).
- Use aged numbers with normal chat history, and personalise messages so they're not identical.
- Watch for low reply rates or blocks; that's what triggers bans.

For high volume or guaranteed delivery, use the official **WhatsApp Business Platform (Cloud API)**.
The API layer here is designed so you can swap `src/whatsapp.js` for a Cloud API implementation later
without changing your integrations.

Follow your local marketing and privacy laws (e.g. India's DPDP Act and TRAI rules, GDPR in the EU).

## Production notes

- Put it behind HTTPS (nginx / Caddy) and set a strong `ADMIN_PASSWORD`.
- Run with a process manager: `npm i -g pm2 && pm2 start server.js --name wa-marketing`.
- `data/db.json` is fine for a few thousand contacts; move to PostgreSQL/MongoDB for larger scale.
- Back up the `sessions/` folder; losing it means re-scanning QR codes.
