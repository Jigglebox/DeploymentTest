// Lockfile: pin a hash of every tool definition so a silently changed description (rug-pull) is caught.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const stable = (v) => JSON.stringify(v, Object.keys(flatten(v)).sort());
function flatten(v, out = {}) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out[k] = 1; flatten(x, out); } return out; }
export const toolHash = (t) => createHash('sha256').update(stable({ name: t.name, title: t.title ?? '', description: t.description ?? '', inputSchema: t.inputSchema ?? t.input_schema ?? {}, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null })).digest('hex').slice(0, 24);

export function buildLock(results) {
  const servers = {};
  for (const r of results) {
    if (r.error) continue;
    servers[r.name] = { serverInfo: r.serverInfo, tools: Object.fromEntries(r.tools.map((t) => [t.name, toolHash(t)])) };
  }
  return { version: 1, generatedAt: new Date().toISOString(), servers };
}

export function diffLock(lock, results) {
  const changes = [];
  for (const r of results) {
    if (r.error) continue;
    const locked = lock.servers?.[r.name];
    if (!locked) { changes.push({ server: r.name, type: 'server_added', tools: r.tools.map((t) => t.name) }); continue; }
    const live = Object.fromEntries(r.tools.map((t) => [t.name, toolHash(t)]));
    for (const [name, h] of Object.entries(live)) {
      if (!(name in locked.tools)) changes.push({ server: r.name, tool: name, type: 'tool_added' });
      else if (locked.tools[name] !== h) changes.push({ server: r.name, tool: name, type: 'tool_changed' });
    }
    for (const name of Object.keys(locked.tools)) if (!(name in live)) changes.push({ server: r.name, tool: name, type: 'tool_removed' });
  }
  return changes;
}

export const readLock = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const writeLock = (path, lock) => writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
