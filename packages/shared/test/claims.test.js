// Guard against copy drifting past the code: phrases retired in docs/CLAIMS_AUDIT.md must not reappear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const files = [
  ...readdirSync(join(root, 'site')).filter((f) => f.endsWith('.html')).map((f) => join(root, 'site', f)),
  join(root, 'README.md'),
  ...['agentfuse', 'recoverkit', 'mcp-sentinel', 'sentinel-cloud'].map((p) => join(root, 'packages', p, 'README.md')),
];
const RETIRED = [
  [/\bSSO\b/, 'single sign-on is not implemented'],
  [/PagerDuty/i, 'no PagerDuty integration exists'],
  [/nightly re-scans?/i, 're-scans run on a configurable interval, not nightly'],
  [/org-wide policy/i, 'no org-wide policy feature exists'],
  [/included with AgentFuse Team/i, 'no cross-product entitlement exists'],
  [/monitoring included/i, 'no cross-product entitlement exists'],
  [/Every response carries/i, 'streamed responses cannot carry cost headers'],
  [/5–9%/, 'unsourced statistic'],
  [/npx --yes mcp-sentinel/, 'the action must not depend on the unpublished npm package'],
];

test('retired or unsupported claims do not reappear in public copy', () => {
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [re, why] of RETIRED) if (re.test(text)) offenders.push(`${f.replace(root + '/', '')}: ${re} (${why})`);
  }
  assert.deepEqual(offenders, []);
});

test('advertised integration points exist in the code', () => {
  const agentfuse = readFileSync(join(root, 'packages/agentfuse/src/admin.js'), 'utf8') + readFileSync(join(root, 'packages/agentfuse/src/proxy.js'), 'utf8');
  assert.ok(agentfuse.includes("'/api/export.csv'"), 'CSV audit export route');
  assert.ok(agentfuse.includes('mailer.send('), 'email alerts on trip');
  const fees = readFileSync(join(root, 'packages/recoverkit/src/fees.js'), 'utf8');
  assert.ok(fees.includes('createInvoice('), 'monthly fee invoicing');
  const action = readFileSync(join(root, 'packages/mcp-sentinel/action.yml'), 'utf8');
  assert.ok(action.includes('github.action_path'), 'action runs from its own checkout');
});
