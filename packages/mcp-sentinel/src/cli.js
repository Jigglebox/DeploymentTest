#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { listTools, serversFromConfig } from './client.js';
import { analyzeServer, maxSeverity, SEVERITY_RANK } from './analyzer.js';
import { buildLock, diffLock, readLock, writeLock } from './lock.js';

// mcp-sentinel is published standalone (no workspace deps), so the guard lives here rather than in @jigglebox/shared.
const isMain = (u) => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href === u : false; } catch { return false; } };

const CANDIDATE_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', `${homedir()}/.claude.json`, `${homedir()}/.cursor/mcp.json`,
  `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`, `${process.env.APPDATA ?? ''}/Claude/claude_desktop_config.json`];

function usage() {
  console.log(`mcp-sentinel — catch poisoned and rug-pulled MCP tools before your agent runs them

Usage:
  mcp-sentinel scan [config.json] [--json] [--fail-on high|medium|low] [--lock mcp-sentinel.lock.json] [--update-lock] [--only name,name]
  mcp-sentinel analyze tools.json        # analyze a saved tools/list result (no servers started)

Config: any {"mcpServers": {...}} file (Claude Desktop, Claude Code .mcp.json, Cursor, VS Code). Defaults to the first one found.
Exit codes: 0 clean · 1 findings at/above --fail-on (default: high) or lock drift · 2 usage/connection error`);
}

function parseArgs(argv) {
  const out = { _: [], failOn: 'high', lock: 'mcp-sentinel.lock.json', json: false, updateLock: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--update-lock') out.updateLock = true;
    else if (a === '--fail-on') out.failOn = argv[++i];
    else if (a === '--lock') out.lock = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',');
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

export async function scanServers(servers, { timeoutMs } = {}) {
  return Promise.all(servers.map(async (s) => {
    try { const r = await listTools(s, { timeoutMs }); return { name: s.name, ...r, findings: analyzeServer(s.name, r.tools) }; }
    catch (err) { return { name: s.name, error: err.message, tools: [], findings: [] }; }
  }));
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = Object.fromEntries(Object.entries({ high: '\x1b[31m', medium: '\x1b[33m', low: '\x1b[36m', reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m' }).map(([k, v]) => [k, useColor ? v : '']));
function printReport(results, changes, lockExists) {
  for (const r of results) {
    if (r.error) { console.log(`${COLORS.bold}${r.name}${COLORS.reset}  ${COLORS.high}✖ ${r.error}${COLORS.reset}`); continue; }
    const worst = maxSeverity(r.findings);
    const badge = worst === 3 ? `${COLORS.high}HIGH RISK` : worst === 2 ? `${COLORS.medium}SUSPICIOUS` : worst === 1 ? `${COLORS.low}NOTES` : `${COLORS.green}clean`;
    console.log(`${COLORS.bold}${r.name}${COLORS.reset} ${COLORS.dim}(${r.serverInfo?.name ?? '?'} ${r.serverInfo?.version ?? ''}, ${r.tools.length} tools)${COLORS.reset}  ${badge}${COLORS.reset}`);
    for (const f of r.findings) console.log(`  ${COLORS[f.severity]}${f.severity.padEnd(6)}${COLORS.reset} ${f.tool}  ${f.title}  ${COLORS.dim}[${f.rule} @ ${f.where}] "${f.evidence.replace(/\s+/g, ' ')}"${COLORS.reset}`);
  }
  if (changes.length) {
    console.log(`\n${COLORS.high}${COLORS.bold}Lock drift (possible rug-pull):${COLORS.reset}`);
    for (const c of changes) console.log(`  ${COLORS.high}${c.type.padEnd(14)}${COLORS.reset} ${c.server}${c.tool ? ' / ' + c.tool : ''}${c.tools ? ' (' + c.tools.join(', ') + ')' : ''}`);
  } else if (lockExists) console.log(`\n${COLORS.green}✔ tool definitions match lockfile${COLORS.reset}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd) { usage(); process.exit(cmd ? 0 : 2); }

  let results;
  if (cmd === 'analyze') {
    const file = args._[1]; if (!file) { usage(); process.exit(2); }
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const tools = json.tools ?? json;
    results = [{ name: file, serverInfo: null, tools, findings: analyzeServer(file, tools) }];
  } else if (cmd === 'scan') {
    const configPath = args._[1] ?? CANDIDATE_CONFIGS.find((p) => p && existsSync(p));
    if (!configPath) { console.error('No MCP config found. Pass a path to a {"mcpServers": ...} file.'); process.exit(2); }
    let servers = serversFromConfig(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
    if (args.only) servers = servers.filter((s) => args.only.includes(s.name));
    if (!servers.length) { console.error(`No servers in ${configPath}`); process.exit(2); }
    if (!args.json) console.error(`Scanning ${servers.length} server(s) from ${configPath}…`);
    results = await scanServers(servers);
  } else { usage(); process.exit(2); }

  const lock = cmd === 'scan' ? readLock(args.lock) : null;
  const changes = lock ? diffLock(lock, results) : [];
  if (cmd === 'scan' && (args.updateLock || !lock)) { writeLock(args.lock, buildLock(results)); if (!args.json) console.error(`${lock ? 'Updated' : 'Created'} ${args.lock}`); }

  const threshold = SEVERITY_RANK[args.failOn] ?? 3;
  const failing = results.some((r) => r.error || maxSeverity(r.findings) >= threshold) || (changes.length > 0 && !args.updateLock);
  if (args.json) console.log(JSON.stringify({ results, changes, failing }, null, 2)); else printReport(results, changes, Boolean(lock));
  process.exit(failing ? 1 : 0);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(2); });
