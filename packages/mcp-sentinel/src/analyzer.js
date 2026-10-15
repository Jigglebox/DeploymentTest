// Static heuristics over MCP tool definitions. Each rule returns findings with a severity.
// Rules are data, so adding one is a single entry. Severity: high | medium | low.

const RULES = [
  { id: 'instruction_override', severity: 'high', title: 'Instruction override phrase',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i },
  { id: 'hidden_from_user', severity: 'high', title: 'Tells the model to hide behaviour from the user',
    re: /\b(do not|don't|never|without)\b[^.\n]{0,30}\b(tell|mention|inform|show|reveal|disclose|notify)\b|\b(hide|conceal|keep (this|it|that) (secret|hidden|quiet))\b|\b(without)\b[^.\n]{0,20}\b(asking|confirming|confirmation|permission)\b/i },
  { id: 'important_tag', severity: 'medium', title: 'Pseudo-system markup in description',
    re: /<\s*\/?\s*(important|system|instructions?|admin|secret|hidden|critical)\s*>|\[\s*(system|important|admin)\s*\]/i },
  { id: 'exfil_target', severity: 'high', title: 'References sensitive files or secrets',
    re: /(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/passwd|\/etc\/shadow|\.env\b|\.npmrc|\.git-credentials|\.netrc|mcp\.json|claude_desktop_config|keychain|private key|api[_ -]?keys?|access token|session cookie|password)/i },
  { id: 'cross_tool_coupling', severity: 'medium', title: 'Conditions behaviour of other tools (tool shadowing)',
    re: /\b(whenever|when|before|after|every time)\b[^.\n]{0,40}\b(you|the (model|assistant|agent))\b[^.\n]{0,20}\b(call|use|invoke|run)s?\b[^.\n]{0,40}\b(any|other|another|all|every)\b[^.\n]{0,20}\btools?\b/i },
  { id: 'forced_invocation', severity: 'medium', title: 'Demands unconditional invocation',
    re: /\b(always|must|required to|you have to)\b[^.\n]{0,30}\b(call|invoke|use|run)\b[^.\n]{0,20}\b(this|the) tool\b[^.\n]{0,30}\b(first|before|every|each|all)\b/i },
  { id: 'send_elsewhere', severity: 'high', title: 'Instructs sending data to an external destination',
    re: /\b(send|post|upload|forward|transmit|email|exfiltrate)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,10}(https?:\/\/|[a-z0-9-]+\.(com|net|io|dev|xyz|ru|cn)\b|[\w.+-]+@[\w-]+\.\w+)/i },
  { id: 'persuasion', severity: 'low', title: 'Social-engineering language aimed at the model',
    re: /\b(this is (very )?important|trust me|you are (now )?(authorized|allowed|permitted)|for security reasons you must|as an? (admin|developer|root))\b/i },
];

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/u;
const BIDI = /[‪-‮⁦-⁩]/;
const HTML_COMMENT = /<!--[\s\S]*?-->/;
const BASE64_BLOB = /(?:[A-Za-z0-9+/]{4}){20,}={0,2}/;
const DANGEROUS_PARAMS = /^(cmd|command|shell|script|exec|sql|query|path|file_?path|url|code)$/i;

function* textsOf(tool) {
  if (tool.description) yield { where: 'description', text: String(tool.description) };
  if (tool.title) yield { where: 'title', text: String(tool.title) };
  const walk = function* (schema, path) {
    if (!schema || typeof schema !== 'object') return;
    if (typeof schema.description === 'string') yield { where: `schema:${path || '$'}.description`, text: schema.description };
    if (typeof schema.title === 'string' && path) yield { where: `schema:${path}.title`, text: schema.title };
    for (const [k, v] of Object.entries(schema.properties ?? {})) yield* walk(v, path ? `${path}.${k}` : k);
    for (const key of ['items', 'additionalProperties']) if (schema[key] && typeof schema[key] === 'object') yield* walk(schema[key], `${path}.${key}`);
    for (const key of ['anyOf', 'oneOf', 'allOf']) for (const [i, s] of (schema[key] ?? []).entries()) yield* walk(s, `${path}.${key}[${i}]`);
  };
  yield* walk(tool.inputSchema ?? tool.input_schema, '');
}

/** Analyze one tool definition. Returns findings[]. */
export function analyzeTool(tool, { allToolNames = [], serverName = '' } = {}) {
  const findings = [];
  const add = (rule, where, evidence) => findings.push({ server: serverName, tool: tool.name, rule: rule.id, severity: rule.severity, title: rule.title, where, evidence: evidence.slice(0, 160) });

  for (const { where, text } of textsOf(tool)) {
    for (const rule of RULES) { const m = rule.re.exec(text); if (m) add(rule, where, m[0]); }
    const zw = text.match(ZERO_WIDTH);
    if (zw) add({ id: 'zero_width_chars', severity: 'high', title: 'Zero-width / invisible characters (hidden text)' }, where, `${zw.length} invisible chars`);
    if (UNICODE_TAGS.test(text)) add({ id: 'unicode_tags', severity: 'high', title: 'Unicode tag characters (invisible instruction smuggling)' }, where, 'U+E00xx range present');
    if (BIDI.test(text)) add({ id: 'bidi_override', severity: 'medium', title: 'Bidirectional override characters' }, where, 'bidi control chars');
    const hc = HTML_COMMENT.exec(text);
    if (hc) add({ id: 'html_comment', severity: 'medium', title: 'HTML comment hidden in text' }, where, hc[0]);
    const b64 = BASE64_BLOB.exec(text);
    if (b64) add({ id: 'base64_blob', severity: 'medium', title: 'Large base64 blob in text' }, where, b64[0].slice(0, 40) + '…');
    if (text.length > 2000) add({ id: 'oversized_text', severity: 'low', title: 'Unusually long text (>2000 chars)' }, where, `${text.length} chars`);
    if (/\n{4,}|[ \t]{40,}/.test(text)) add({ id: 'whitespace_padding', severity: 'medium', title: 'Excessive whitespace (content pushed out of view)' }, where, 'padding');
    for (const other of allToolNames) {
      if (other !== tool.name && other.length > 3 && new RegExp(`\\b${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text) && /\b(when|before|after|instead|also|call|use)\b/i.test(text)) {
        add({ id: 'references_other_tool', severity: 'medium', title: 'Mentions another tool by name (possible shadowing)' }, where, other);
        break;
      }
    }
  }
  const props = (tool.inputSchema ?? tool.input_schema)?.properties ?? {};
  for (const [name, schema] of Object.entries(props)) {
    if (DANGEROUS_PARAMS.test(name) && !schema.enum && !schema.pattern && /\b(exec|execut|run|shell|arbitrary|any)\b/i.test(String(tool.description ?? '') + String(schema.description ?? ''))) {
      add({ id: 'unconstrained_dangerous_param', severity: 'low', title: 'Unconstrained parameter that drives execution' }, `schema:${name}`, `${name}: no enum/pattern`);
    }
  }
  // Dedupe identical (rule, where)
  const seen = new Set();
  return findings.filter((f) => { const k = f.rule + '|' + f.where; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function analyzeServer(serverName, tools) {
  const names = tools.map((t) => t.name);
  return tools.flatMap((t) => analyzeTool(t, { allToolNames: names, serverName }));
}

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
export const maxSeverity = (findings) => findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), 0);
