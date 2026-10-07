'use strict';

const { MODELS, GROQ_URL, GENERATION, TIMEOUTS } = require('./_config');

/*
   Streams one chat completion from Groq, with a single fallback attempt.

   streamCompletion({ messages, apiKey, signal, emit })
     emit(text)  is called for every chunk of generated text.
     resolves    { model, finish }   finish is the provider's finish_reason ("stop", "length", ...)
     rejects     UpstreamError       with a short code that is safe to show to the client.

   Fallback rules: the fallback model is only tried when the primary failed
   BEFORE any text was emitted, and only for failures a second model can fix
   (rate limit, 404/5xx, timeout, network, empty or malformed stream).
   Auth errors and rejected requests (4xx) are never retried.
*/

class UpstreamError extends Error {
  constructor(code, { status = 0, fallback = false, retryAfter = 0 } = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.fallback = fallback;
    this.retryAfter = retryAfter;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return { code: 'upstream_auth', fallback: false };
  if (status === 429) return { code: 'rate_limited', fallback: true };
  if (status === 404 || status === 408 || status >= 500) return { code: 'upstream_error', fallback: true };
  return { code: 'upstream_rejected', fallback: false };
}

async function attempt({ model, messages, apiKey, clientSignal, emit }) {
  if (clientSignal.aborted) throw new UpstreamError('client_closed');

  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  clientSignal.addEventListener('abort', onClientAbort, { once: true });

  let timedOut = false;
  let timer = null;
  let emitted = 0;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  };
  const fail = () => {
    if (clientSignal.aborted) return new UpstreamError('client_closed');
    return new UpstreamError(timedOut ? 'timeout' : 'network', { fallback: emitted === 0 });
  };

  try {
    arm(TIMEOUTS.firstChunkMs);

    let res;
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({ model, messages, stream: true, ...GENERATION }),
        signal: controller.signal
      });
    } catch (err) {
      throw fail();
    }

    if (!res.ok) {
      const { code, fallback } = classifyStatus(res.status);
      const retryAfter = Math.min(60, Math.max(0, parseInt(res.headers.get('retry-after') || '0', 10) || 0));
      throw new UpstreamError(code, { status: res.status, fallback, retryAfter });
    }
    if (!res.body) throw new UpstreamError('upstream_malformed', { fallback: true });

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let finish = null;

    const handleLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; return; }
      let data;
      try { data = JSON.parse(payload); } catch (err) {
        throw new UpstreamError('upstream_malformed', { fallback: emitted === 0 });
      }
      if (data && data.error) throw new UpstreamError('upstream_error', { fallback: emitted === 0 });
      const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
      if (!choice) return;
      const text = choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
      if (text) { emitted += 1; emit(text); }
      if (choice.finish_reason) finish = choice.finish_reason;
    };

    try {
      for await (const chunk of res.body) {
        arm(TIMEOUTS.idleMs);
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw fail();
    }

    if (clientSignal.aborted) throw new UpstreamError('client_closed');
    if (!done && finish === null) throw new UpstreamError('stream_interrupted', { fallback: emitted === 0 });
    if (emitted === 0) throw new UpstreamError('empty_response', { fallback: true });
    return { model, finish };
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener('abort', onClientAbort);
    controller.abort(); // releases the upstream connection on every exit path
  }
}

async function streamCompletion({ messages, apiKey, signal, emit }) {
  const order = [MODELS.primary, MODELS.fallback];
  let emittedAny = false;
  const tracked = (text) => { emittedAny = true; emit(text); };

  for (let i = 0; i < order.length; i += 1) {
    try {
      return await attempt({ model: order[i], messages, apiKey, clientSignal: signal, emit: tracked });
    } catch (err) {
      const e = err instanceof UpstreamError ? err : new UpstreamError('upstream_error');
      const last = i === order.length - 1;
      if (e.code === 'client_closed' || emittedAny || !e.fallback || last) throw e;
      console.warn(`[api/chat] primary model failed (${e.code}${e.status ? ` ${e.status}` : ''}), trying fallback model`);
    }
  }
  throw new UpstreamError('upstream_error');
}

module.exports = { streamCompletion, UpstreamError };
