import { createServer } from 'node:http';

/** A fake OpenAI/Anthropic upstream that returns deterministic usage. */
export function fakeUpstream() {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, headers: req.headers, body });
    const outTokens = body.max_tokens ?? 100;
    if (req.url.startsWith('/v1/chat/completions')) {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'hel' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'lo' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 1000, completion_tokens: outTokens } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'c1', model: body.model, choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 1000, completion_tokens: outTokens } }));
      }
    } else if (req.url.startsWith('/v1/messages')) {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2000, output_tokens: 1 } } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: outTokens } })}\n\n`);
        res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm1', model: body.model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 2000, output_tokens: outTokens } }));
      }
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

export const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));
