/* ==========================================================================
   Kashvee chat transport. The only code that talks to /api/chat.

   KashveeChatAPI.stream(request, { signal, onDelta }) -> Promise<{ text, truncated }>

   request = { message, history: [{ role, text }], context: { profile, prefs, memories, notes } }

   Rejects with:
     - an AbortError            when the caller's signal aborts (no message to show)
     - a ChatError (.code)      for everything else; .userMessage is safe to display
   Chunks are delivered through onDelta(text) as they arrive.
   The Groq key and model names never reach this file: they live on the server.
   ========================================================================== */
(function () {
  'use strict';

  const ENDPOINT = '/api/chat';
  const IDLE_TIMEOUT_MS = 45000; // no bytes at all for this long: give up

  const USER_MESSAGES = {
    rate_limited: 'Kashvee is getting a lot of requests right now. Try again in a moment.',
    timeout: 'Kashvee took too long to respond.',
    network: "Couldn't reach Kashvee. Check your connection.",
    stream_interrupted: 'The reply was interrupted.',
    message_too_long: 'That message is too long to send.',
    empty_message: 'Write a message first.',
    request_too_large: 'That message is too long to send.',
    not_configured: "Kashvee's chat service isn't set up yet.",
    default: "Kashvee couldn't reply just now."
  };

  class ChatError extends Error {
    constructor(code) {
      super(code);
      this.name = 'ChatError';
      this.code = code;
      this.userMessage = USER_MESSAGES[code] || USER_MESSAGES.default;
    }
  }

  const ROLE_MAP = { kashvee: 'assistant', assistant: 'assistant', user: 'user' };

  /* Wire format. The server validates again; this just keeps requests small and well-formed. */
  function toBody(request) {
    const ctx = request.context || {};
    return {
      message: String(request.message || ''),
      history: (request.history || [])
        .filter((m) => m && typeof m.text === 'string' && m.text.trim() && ROLE_MAP[m.role])
        .map((m) => ({ role: ROLE_MAP[m.role], text: m.text.slice(0, 4000) })),
      context: {
        profile: { name: (ctx.profile && ctx.profile.name) || '', interests: (ctx.profile && ctx.profile.interests) || '' },
        prefs: { tone: ctx.prefs && ctx.prefs.tone, length: ctx.prefs && ctx.prefs.length },
        memories: (ctx.memories || []).map((m) => (typeof m === 'string' ? m : m.text)).filter(Boolean),
        notes: ctx.notes || []
      }
    };
  }

  async function errorCodeFromResponse(res) {
    try {
      const data = await res.json();
      if (data && data.error && typeof data.error.code === 'string') return data.error.code;
    } catch (err) { /* not JSON */ }
    return res.status === 429 ? 'rate_limited' : 'upstream_error';
  }

  async function stream(request, { signal, onDelta } = {}) {
    // Own controller so the idle watchdog and the caller's signal can both stop the request.
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
    };
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const callerAborted = () => Boolean(signal && signal.aborted);

    let text = '';
    let truncated = false;
    let finished = false;
    let reader = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch (err) { throw new ChatError('upstream_error'); }
      if (event.t === 'delta' && typeof event.v === 'string') {
        text += event.v;
        if (onDelta) onDelta(event.v);
      } else if (event.t === 'done') {
        finished = true;
        truncated = event.reason === 'length';
      } else if (event.t === 'error') {
        throw new ChatError(typeof event.c === 'string' ? event.c : 'upstream_error');
      }
    };

    try {
      arm();
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify(toBody(request)),
          signal: controller.signal
        });
      } catch (err) {
        if (callerAborted()) throw new DOMException('Aborted', 'AbortError');
        throw new ChatError(timedOut ? 'timeout' : 'network');
      }
      if (!res.ok) throw new ChatError(await errorCodeFromResponse(res));

      const decoder = new TextDecoder();
      let buffer = '';
      try {
        if (res.body && res.body.getReader) {
          reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              handleLine(line);
            }
          }
        } else {
          buffer = await res.text(); // very old browsers: no progressive rendering
          buffer.split('\n').forEach(handleLine);
          buffer = '';
        }
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
      } catch (err) {
        if (err instanceof ChatError) throw err;
        if (callerAborted()) throw new DOMException('Aborted', 'AbortError');
        throw new ChatError(timedOut ? 'timeout' : 'stream_interrupted');
      }

      if (callerAborted()) throw new DOMException('Aborted', 'AbortError');
      if (!finished) throw new ChatError('stream_interrupted');
      return { text, truncated };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      if (reader) { try { reader.cancel(); } catch (err) { /* already closed */ } }
      controller.abort();
    }
  }

  window.KashveeChatAPI = { stream, ChatError };
})();
