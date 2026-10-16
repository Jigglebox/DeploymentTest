import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, nowIso } from '@jigglebox/shared/db';

const MIGRATIONS = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
     alert_webhook TEXT, fail_on TEXT NOT NULL DEFAULT 'high', created_at TEXT NOT NULL);
   CREATE TABLE monitored_servers (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT, enabled INTEGER NOT NULL DEFAULT 1,
     last_scan_at TEXT, next_scan_at TEXT, created_at TEXT NOT NULL, UNIQUE(project_id, name));
   CREATE TABLE scans (
     id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     server TEXT NOT NULL, source TEXT NOT NULL, server_info TEXT, tool_count INTEGER NOT NULL DEFAULT 0,
     tool_hashes TEXT NOT NULL, findings TEXT NOT NULL, max_severity INTEGER NOT NULL DEFAULT 0,
     drift TEXT NOT NULL DEFAULT '[]', new_findings TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL);
   CREATE INDEX scans_project_server ON scans(project_id, server, id);
   CREATE TABLE alerts (
     id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, server TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);`,
];
const hash = (s) => createHash('sha256').update(s).digest('hex');

export class Store {
  constructor(dbPath = ':memory:') {
    this.db = openDatabase(dbPath, MIGRATIONS);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      insertProject: p('INSERT INTO projects (id,name,token_hash,token_prefix,alert_webhook,fail_on,created_at) VALUES (?,?,?,?,?,?,?)'),
      projectByToken: p('SELECT * FROM projects WHERE token_hash=?'),
      projectById: p('SELECT * FROM projects WHERE id=?'),
      listProjects: p('SELECT * FROM projects ORDER BY created_at DESC'),
      countProjects: p('SELECT COUNT(*) AS n FROM projects'),
      updateProject: p('UPDATE projects SET alert_webhook=COALESCE(?,alert_webhook), fail_on=COALESCE(?,fail_on) WHERE id=?'),
      deleteProject: p('DELETE FROM projects WHERE id=?'),
      upsertServer: p(`INSERT INTO monitored_servers (id,project_id,name,url,headers,enabled,next_scan_at,created_at) VALUES (?,?,?,?,?,1,?,?)
                       ON CONFLICT(project_id,name) DO UPDATE SET url=excluded.url, headers=excluded.headers, enabled=1`),
      serversFor: p('SELECT * FROM monitored_servers WHERE project_id=? ORDER BY name'),
      dueServers: p('SELECT * FROM monitored_servers WHERE enabled=1 AND (next_scan_at IS NULL OR next_scan_at<=?) ORDER BY next_scan_at LIMIT 100'),
      markScanned: p('UPDATE monitored_servers SET last_scan_at=?, next_scan_at=? WHERE id=?'),
      deleteServer: p('DELETE FROM monitored_servers WHERE project_id=? AND name=?'),
      insertScan: p(`INSERT INTO scans (project_id,server,source,server_info,tool_count,tool_hashes,findings,max_severity,drift,new_findings,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      latestScan: p('SELECT * FROM scans WHERE project_id=? AND server=? AND error IS NULL ORDER BY id DESC LIMIT 1'),
      latestPerServer: p('SELECT s.* FROM scans s JOIN (SELECT server, MAX(id) AS id FROM scans WHERE project_id=? GROUP BY server) m ON m.id=s.id ORDER BY s.server'),
      history: p('SELECT * FROM scans WHERE project_id=? AND server=? ORDER BY id DESC LIMIT ?'),
      insertAlert: p('INSERT INTO alerts (project_id,server,type,detail,created_at) VALUES (?,?,?,?,?)'),
      alertsFor: p('SELECT * FROM alerts WHERE project_id=? ORDER BY id DESC LIMIT ?'),
    };
  }
  _project(row) { return row ? { ...row, token_hash: undefined } : null; }
  createProject({ name, alertWebhook = null, failOn = 'high' }) {
    const raw = 'sn_' + randomBytes(24).toString('base64url');
    const id = 'proj_' + randomBytes(6).toString('hex');
    this.q.insertProject.run(id, name, hash(raw), raw.slice(0, 8) + '…', alertWebhook, failOn, nowIso());
    return { ...this._project(this.q.projectById.get(id)), raw_token: raw };
  }
  projectByToken(raw) { return this._project(this.q.projectByToken.get(hash(raw))); }
  getProject(id) { return this._project(this.q.projectById.get(id)); }
  listProjects() { return this.q.listProjects.all().map((r) => this._project(r)); }
  countProjects() { return this.q.countProjects.get().n; }
  updateProject(id, { alertWebhook = null, failOn = null }) { this.q.updateProject.run(alertWebhook, failOn, id); return this.getProject(id); }
  deleteProject(id) { this.q.deleteProject.run(id); }

  addServer(projectId, { name, url, headers = {} }) { this.q.upsertServer.run('srv_' + randomBytes(6).toString('hex'), projectId, name, url, JSON.stringify(headers), nowIso(), nowIso()); return this.serversFor(projectId).find((s) => s.name === name); }
  serversFor(projectId) { return this.q.serversFor.all(projectId).map((s) => ({ ...s, headers: JSON.parse(s.headers ?? '{}') })); }
  dueServers(now = nowIso()) { return this.q.dueServers.all(now).map((s) => ({ ...s, headers: JSON.parse(s.headers ?? '{}') })); }
  markScanned(id, nextAt) { this.q.markScanned.run(nowIso(), nextAt, id); }
  deleteServer(projectId, name) { this.q.deleteServer.run(projectId, name); }

  recordScan(s) {
    this.q.insertScan.run(s.projectId, s.server, s.source, JSON.stringify(s.serverInfo ?? null), s.toolCount ?? 0, JSON.stringify(s.toolHashes ?? {}), JSON.stringify(s.findings ?? []), s.maxSeverity ?? 0, JSON.stringify(s.drift ?? []), JSON.stringify(s.newFindings ?? []), s.error ?? null, nowIso());
  }
  _scan(r) { return r ? { ...r, server_info: JSON.parse(r.server_info ?? 'null'), tool_hashes: JSON.parse(r.tool_hashes), findings: JSON.parse(r.findings), drift: JSON.parse(r.drift), new_findings: JSON.parse(r.new_findings) } : null; }
  latestScan(projectId, server) { return this._scan(this.q.latestScan.get(projectId, server)); }
  latestPerServer(projectId) { return this.q.latestPerServer.all(projectId).map((r) => this._scan(r)); }
  history(projectId, server, limit = 50) { return this.q.history.all(projectId, server, limit).map((r) => this._scan(r)); }
  alert(projectId, server, type, detail) { this.q.insertAlert.run(projectId, server, type, JSON.stringify(detail), nowIso()); }
  alertsFor(projectId, limit = 50) { return this.q.alertsFor.all(projectId, limit).map((a) => ({ ...a, detail: JSON.parse(a.detail) })); }
  close() { this.db.close(); }
}
