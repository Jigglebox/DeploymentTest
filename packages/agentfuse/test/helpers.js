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
    if (req.url.startsWith('/v1/audio/speech')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xfe]));
    }
    if (req.url.startsWith('/v1/files')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"file-secret"}]}'); }
    if (req.url.startsWith('/v1/chat/completions') && body.model === 'gpt-4o-nousage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'c3', model: body.model, choices: [{ message: { role: 'assistant', content: 'x' } }] })); // no usage field
    }
    if (req.url.startsWith('/v1/chat/completions') && body.model === 'gpt-4o-cached') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'c2', model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } } }));
    }
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
