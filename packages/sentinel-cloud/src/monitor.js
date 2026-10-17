// Turns a scan result (from the CLI's --report or our own scheduled scan) into history, drift and alerts.
import { toolHash } from 'mcp-sentinel/lock';
import { analyzeServer, maxSeverity, SEVERITY_RANK } from 'mcp-sentinel/analyzer';
import { listTools } from 'mcp-sentinel/client';
import { postWebhook } from '@jigglebox/shared/notify';
import { log } from '@jigglebox/shared/log';

export class Monitor {
  constructor({ store, config, fetchImpl = fetch, now = () => new Date() }) { Object.assign(this, { store, config, fetchImpl, now }); }

  /** Ingest one server's tools (+ optional precomputed findings) for a project. Returns the stored scan summary. */
  async ingest(project, { server, tools = [], serverInfo = null, findings = null, error = null, source = 'report' }) {
    if (error) { this.store.recordScan({ projectId: project.id, server, source, error }); await this.notify(project, server, 'unreachable', { error }); return { server, error }; }
    const toolHashes = Object.fromEntries(tools.map((t) => [t.name, toolHash(t)]));
    const found = findings ?? analyzeServer(server, tools);
    const previous = this.store.latestScan(project.id, server);
    const drift = previous ? diffHashes(previous.tool_hashes, toolHashes) : [];
    const seen = new Set((previous?.findings ?? []).map((f) => `${f.tool}|${f.rule}|${f.where}`));
    const newFindings = found.filter((f) => !seen.has(`${f.tool}|${f.rule}|${f.where}`));
    const summary = { projectId: project.id, server, source, serverInfo, toolCount: tools.length, toolHashes, findings: found, maxSeverity: maxSeverity(found), drift, newFindings };
    this.store.recordScan(summary);
    const threshold = SEVERITY_RANK[project.fail_on] ?? 3;
    const seriousNew = newFindings.filter((f) => SEVERITY_RANK[f.severity] >= threshold);
    if (drift.length) await this.notify(project, server, 'drift', { changes: drift });
    if (seriousNew.length) await this.notify(project, server, 'new_findings', { findings: seriousNew.map((f) => ({ tool: f.tool, rule: f.rule, severity: f.severity, evidence: f.evidence })) });
    return { server, toolCount: tools.length, findings: found.length, newFindings: newFindings.length, drift, maxSeverity: summary.maxSeverity, baseline: !previous };
  }

  async ingestReport(project, report) {
    const out = [];
    for (const r of report.results ?? []) out.push(await this.ingest(project, { server: r.name, tools: r.tools ?? [], serverInfo: r.serverInfo ?? null, findings: r.findings ?? null, error: r.error ?? null, source: 'report' }));
    return out;
  }

  /** Scan one registered HTTP MCP server ourselves. */
  async scanServer(project, srv) {
    try {
      const r = await listTools({ name: srv.name, url: srv.url, headers: srv.headers }, { timeoutMs: this.config.scanTimeoutMs, fetchImpl: this.fetchImpl });
      return await this.ingest(project, { server: srv.name, tools: r.tools, serverInfo: r.serverInfo, source: 'scheduled' });
    } catch (err) {
      return await this.ingest(project, { server: srv.name, error: err.message, source: 'scheduled' });
    } finally {
      this.store.markScanned(srv.id, new Date(this.now().getTime() + this.config.scanIntervalSec * 1000).toISOString());
    }
  }

  async tick() {
    const results = [];
    for (const srv of this.store.dueServers(this.now().toISOString())) {
      const project = this.store.getProject(srv.project_id);
      if (project) results.push(await this.scanServer(project, srv));
    }
    return results;
  }

  async notify(project, server, type, detail) {
    this.store.alert(project.id, server, type, detail);
    const text = type === 'drift' ? `mcp-sentinel: tool definitions changed on "${server}" (${project.name}): ${detail.changes.map((c) => `${c.type} ${c.tool ?? ''}`).join(', ')}`
      : type === 'new_findings' ? `mcp-sentinel: ${detail.findings.length} new finding(s) on "${server}" (${project.name}): ${detail.findings.map((f) => `${f.severity} ${f.rule} @ ${f.tool}`).join('; ')}`
      : `mcp-sentinel: "${server}" (${project.name}) unreachable: ${detail.error}`;
    log.warn('alert', { project: project.id, server, type });
    await postWebhook(project.alert_webhook, { text, type, project: project.id, server, ...detail }, { fetchImpl: this.fetchImpl });
  }
}

export function diffHashes(prev, next) {
  const changes = [];
  for (const [tool, h] of Object.entries(next)) { if (!(tool in prev)) changes.push({ type: 'tool_added', tool }); else if (prev[tool] !== h) changes.push({ type: 'tool_changed', tool }); }
  for (const tool of Object.keys(prev)) if (!(tool in next)) changes.push({ type: 'tool_removed', tool });
  return changes;
}
