// Outbound alerting: posts to a Slack-compatible or generic JSON webhook. Never throws.
import { log } from './log.js';

export async function postWebhook(url, payload, { fetchImpl = fetch } = {}) {
  if (!url) return false;
  try {
    const body = url.includes('hooks.slack.com') ? { text: payload.text ?? JSON.stringify(payload) } : payload;
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) log.warn('webhook non-2xx', { status: res.status });
    return res.ok;
  } catch (err) {
    log.warn('webhook failed', { error: err.message });
    return false;
  }
}
