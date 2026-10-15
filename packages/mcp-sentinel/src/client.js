// Minimal MCP client: enough of JSON-RPC 2.0 to run `initialize` and `tools/list` over
// stdio (spawned process) or Streamable HTTP. No SDK dependency.
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'mcp-sentinel', version: '0.1.0' };

class Rpc {
  constructor() { this.nextId = 1; this.pending = new Map(); }
  _settle(msg) {
    if (msg.id == null || !this.pending.has(msg.id)) return;
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    msg.error ? reject(Object.assign(new Error(msg.error.message ?? 'rpc error'), { code: msg.error.code, data: msg.error.data })) : resolve(msg.result);
  }
  _failAll(err) { for (const { reject } of this.pending.values()) reject(err); this.pending.clear(); }
}

export class StdioClient extends Rpc {
  constructor({ command, args = [], env = {}, cwd, timeoutMs = 15000 }) {
    super();
    this.timeoutMs = timeoutMs;
    this.stderr = '';
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { this._settle(JSON.parse(line)); } catch { /* non-JSON noise on stdout */ }
      }
    });
    this.proc.stdin.on('error', () => { /* EPIPE after the server exited; the exit handler reports it */ });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString('utf8').slice(0, 4000); });
    this.exited = new Promise((r) => this.proc.on('exit', (code) => { this._failAll(new Error(`server exited (${code}) ${this.stderr.trim().split('\n').at(-1) ?? ''}`)); r(code); }));
    this.proc.on('error', (e) => this._failAll(e));
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close() { try { this.proc.stdin.end(); } catch {} setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 500).unref(); try { this.proc.kill('SIGTERM'); } catch {} }
}

export class HttpClient extends Rpc {
  constructor({ url, headers = {}, timeoutMs = 15000, fetchImpl = fetch }) { super(); Object.assign(this, { url, headers, timeoutMs, fetchImpl, sessionId: null }); }
  async request(method, params) {
    const id = this.nextId++;
    const res = await this.fetchImpl(this.url, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers, ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}`);
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const msgs = ct.includes('text/event-stream')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean)
      : [JSON.parse(text)];
    const reply = msgs.find((m) => m.id === id);
    if (!reply) throw new Error(`no response for ${method}`);
    if (reply.error) throw new Error(reply.error.message ?? 'rpc error');
    return reply.result;
  }
  async notify(method, params) { await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers, ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, params }) }).catch(() => {}); }
  close() {}
}

/** Connect, handshake, list every tool (following pagination), disconnect. */
export async function listTools(serverConfig, opts = {}) {
  const client = serverConfig.url ? new HttpClient({ ...serverConfig, ...opts }) : new StdioClient({ ...serverConfig, ...opts });
  try {
    const init = await client.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    await client.notify('notifications/initialized', {});
    const tools = [];
    let cursor;
    do {
      const page = await client.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return { serverInfo: init?.serverInfo ?? null, protocolVersion: init?.protocolVersion ?? null, tools };
  } finally { client.close(); }
}

/** Load servers from Claude Desktop / Claude Code / Cursor / Windsurf style config: { mcpServers: {...} } */
export function serversFromConfig(json) {
  const map = json.mcpServers ?? json.servers ?? json;
  return Object.entries(map).filter(([, v]) => v && (v.command || v.url)).map(([name, v]) => ({ name, command: v.command, args: v.args ?? [], env: v.env ?? {}, url: v.url, headers: v.headers ?? {}, cwd: v.cwd }));
}
