// Forwards events to WEBHOOK_URL (if set) as JSON POST requests.
export function emitWebhook(event, data) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
  }).catch((e) => console.warn(`Webhook ${event} failed: ${e.message}`));
}
