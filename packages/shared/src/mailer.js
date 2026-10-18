// Pluggable email sending shared by products. Console in dev/tests; Resend (one HTTP call) in production.
import { log } from './log.js';

export const consoleMailer = { name: 'console', sent: [], async send(msg) { this.sent.push(msg); log.info('email (console mailer)', { to: msg.to, subject: msg.subject }); return { id: 'console' }; } };

export function resendMailer(apiKey, { fetchImpl = fetch } = {}) {
  return {
    name: 'resend',
    async send({ from, to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) });
      if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}

export const mailerFromEnv = (resendApiKey, fetchImpl) => (resendApiKey ? resendMailer(resendApiKey, { fetchImpl }) : consoleMailer);
