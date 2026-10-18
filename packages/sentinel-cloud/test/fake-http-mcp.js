// Minimal Streamable-HTTP MCP server for tests; tools come from a mutable array so drift can be simulated.
import { createServer } from 'node:http';
export function fakeHttpMcp(initialTools) {
  const state = { tools: initialTools, requests: 0 };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const msg = JSON.parse(raw || '{}');
    state.requests++;
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '2.0.0' } });
    if (msg.method === 'tools/list') return reply({ tools: state.tools });
    if (msg.id == null) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}
