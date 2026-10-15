// Shared dashboard chrome: one stylesheet, one layout, so every product looks like one company.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (cents) => (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const usd = (dollars) => Number(dollars || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

export function layout({ title, product, body, nav = [] }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262a33;--text:#e6e8ec;--muted:#9aa3b2;--accent:#5b8def;--ok:#3ecf8e;--warn:#f5b84a;--bad:#ef5b6a}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:20px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
header b{font-size:16px}header nav a{color:var(--muted);margin-right:14px;text-decoration:none}header nav a:hover{color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:24px;font-weight:600;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:rgba(62,207,142,.15);color:var(--ok)}.warn{background:rgba(245,184,74,.15);color:var(--warn)}.bad{background:rgba(239,91,106,.15);color:var(--bad)}.muted{color:var(--muted)}
button,.btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}button.secondary{background:#2a2f3a}
form.inline{display:inline}input,select{background:#0f1115;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 8px;font:inherit}
h2{margin:28px 0 12px;font-size:16px}code{background:#0f1115;padding:1px 5px;border-radius:4px}
.bar{height:8px;background:#262a33;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}
</style></head><body>
<header><b>${esc(product)}</b><nav>${nav.map((n) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`).join('')}</nav></header>
<main>${body}</main></body></html>`;
}
