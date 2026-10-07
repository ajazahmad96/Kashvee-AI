'use strict';

const { LIMITS, ALLOWED, SYSTEM_PROMPT } = require('./_config');

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Removes control characters (keeps \n, \r, \t) and normalises the type.
const clean = (value) => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const squash = (value, max) => clean(value).replace(/\s+/g, ' ').trim().slice(0, max);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateBody(body) {
  if (!isPlainObject(body)) throw new RequestError(400, 'invalid_request');

  // message
  if (typeof body.message !== 'string') throw new RequestError(400, 'invalid_request');
  const message = clean(body.message).trim();
  if (!message) throw new RequestError(400, 'empty_message');
  if (message.length > LIMITS.message) throw new RequestError(413, 'message_too_long');

  // history: only user/assistant roles are accepted, never "system"
  if (body.history !== undefined && !Array.isArray(body.history)) throw new RequestError(400, 'invalid_request');
  let history = [];
  for (const item of body.history || []) {
    if (!isPlainObject(item) || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string') {
      throw new RequestError(400, 'invalid_request');
    }
    const text = clean(item.text).trim().slice(0, LIMITS.historyItemChars);
    if (text) history.push({ role: item.role, content: text });
  }
  history = history.slice(-LIMITS.historyItems);
  let total = history.reduce((sum, m) => sum + m.content.length, 0);
  while (history.length && total > LIMITS.historyTotalChars) total -= history.shift().content.length;

  // context (all optional, all untrusted)
  const ctx = isPlainObject(body.context) ? body.context : {};
  const profile = isPlainObject(ctx.profile) ? ctx.profile : {};
  const prefs = isPlainObject(ctx.prefs) ? ctx.prefs : {};
  const strings = (list, max, maxChars) => (Array.isArray(list) ? list : [])
    .filter((x) => typeof x === 'string')
    .map((x) => squash(x, maxChars))
    .filter(Boolean)
    .slice(0, max);

  const context = {
    name: typeof profile.name === 'string' ? squash(profile.name, LIMITS.profileName) : '',
    interests: typeof profile.interests === 'string' ? squash(profile.interests, LIMITS.profileInterests) : '',
    tone: ALLOWED.tone.includes(prefs.tone) ? prefs.tone : 'balanced',
    replyLength: ALLOWED.length.includes(prefs.length) ? prefs.length : 'balanced',
    memories: strings(ctx.memories, LIMITS.memories, LIMITS.memoryChars),
    appNotes: strings(ctx.notes, LIMITS.notes, LIMITS.noteChars)
  };

  return { message, history, context };
}

/* Builds the data block. JSON-encoded, with < and > escaped so values can never close the tag. */
function contextBlock(context) {
  const data = {
    userName: context.name || null,
    userInterests: context.interests || null,
    preferences: { tone: context.tone, replyLength: context.replyLength },
    savedMemories: context.memories,
    appNotes: context.appNotes
  };
  const json = JSON.stringify(data, null, 1).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<user_context>\n${json}\n</user_context>`;
}

function buildMessages({ message, history, context }) {
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${contextBlock(context)}` },
    ...history,
    { role: 'user', content: message }
  ];
}

module.exports = { RequestError, validateBody, buildMessages };
