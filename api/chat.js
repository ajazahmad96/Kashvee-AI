'use strict';

/*
   POST /api/chat
   Browser -> this function -> Groq (streamed) -> browser.

   Success: 200, Content-Type application/x-ndjson. One JSON object per line:
     {"t":"delta","v":"text chunk"}        repeated
     {"t":"done","reason":"stop|length"}   final line on success
     {"t":"error","c":"<code>"}            final line if the stream breaks after text was sent
   Failure before any text: a normal HTTP error with {"error":{"code","message"}}.

   GROQ_API_KEY is read from the server environment only. It is never logged or returned.
*/

const { LIMITS } = require('./_config');
const { RequestError, validateBody, buildMessages } = require('./_validate');
const { streamCompletion, UpstreamError } = require('./_groq');

const STATUS = {
  rate_limited: 429,
  timeout: 504,
  upstream_auth: 500,
  not_configured: 500
};

const GENERIC_MESSAGE = {
  not_configured: 'The chat service is not configured.',
  rate_limited: 'Too many requests. Please try again shortly.',
  timeout: 'The request took too long.',
  message_too_long: 'The message is too long.',
  empty_message: 'The message is empty.',
  request_too_large: 'The request is too large.',
  method_not_allowed: 'Method not allowed.',
  invalid_request: 'The request was not valid.'
};

function sendJson(res, status, code, headers = {}) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify({ error: { code, message: GENERIC_MESSAGE[code] || 'The chat service is unavailable.' } }));
}

async function collect(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.bodyBytes) throw new RequestError(413, 'request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* Works with Vercel's pre-parsed req.body and with a raw Node request. */
async function readJson(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) throw new RequestError(413, 'request_too_large');

  let pre;
  try { pre = req.body; } catch (err) { throw new RequestError(400, 'invalid_request'); }

  if (pre !== undefined && pre !== null && typeof pre === 'object' && !Buffer.isBuffer(pre)) {
    if (Buffer.byteLength(JSON.stringify(pre)) > LIMITS.bodyBytes) throw new RequestError(413, 'request_too_large');
    return pre;
  }
  const raw = typeof pre === 'string' || Buffer.isBuffer(pre) ? Buffer.from(pre) : await collect(req);
  if (raw.length > LIMITS.bodyBytes) throw new RequestError(413, 'request_too_large');
  try { return JSON.parse(raw.toString('utf8')); } catch (err) { throw new RequestError(400, 'invalid_request'); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-transform');

  if (req.method !== 'POST') {
    return sendJson(res, 405, 'method_not_allowed', { Allow: 'POST' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[api/chat] GROQ_API_KEY is not set in the server environment');
    return sendJson(res, 500, 'not_configured');
  }

  let input;
  try {
    input = validateBody(await readJson(req));
  } catch (err) {
    if (err instanceof RequestError) return sendJson(res, err.status, err.code, err.status === 413 ? { Connection: 'close' } : {});
    return sendJson(res, 400, 'invalid_request');
  }

  // Stop talking to Groq as soon as the browser goes away.
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  let started = false;
  const write = (event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(event)}\n`);
  };
  const begin = () => {
    if (started) return;
    started = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
  };

  try {
    const result = await streamCompletion({
      messages: buildMessages(input),
      apiKey,
      signal: abort.signal,
      emit: (text) => { begin(); write({ t: 'delta', v: text }); }
    });
    begin();
    write({ t: 'done', reason: result.finish === 'length' ? 'length' : 'stop' });
    if (!res.writableEnded) res.end();
  } catch (err) {
    const e = err instanceof UpstreamError ? err : new UpstreamError('upstream_error');
    if (e.code === 'client_closed') {
      if (!res.writableEnded) res.end();
      return undefined;
    }
    // Codes and status numbers only. Never provider bodies, keys or stack traces.
    console.error(`[api/chat] generation failed: ${e.code}${e.status ? ` (upstream ${e.status})` : ''}`);
    if (!started) {
      const code = e.code === 'upstream_auth' ? 'not_configured' : e.code;
      const headers = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {};
      return sendJson(res, STATUS[e.code] || 502, code, headers);
    }
    write({ t: 'error', c: e.code === 'upstream_auth' ? 'upstream_error' : e.code });
    if (!res.writableEnded) res.end();
  }
  return undefined;
};
