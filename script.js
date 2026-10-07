/* ==========================================================================
   Kashvee V1 — script.js
   Plain JavaScript. No build step.

   Sections
     0. Utilities
     1. Personality configuration   <- UI metadata only (name, tagline, traits, tones)
     2. Storage adapter             <- swap for a real database later
     3. Memory layer                <- saveMemory, getMemories, deleteMemory, ...
     4. Memory capture + AI bridge  <- generateKashveeResponse() streams from /api/chat
     5. Voice                       <- Web Speech API
     6. App state
     7. UI primitives               <- toasts, confirm dialog, viewport
     8. Views and navigation
     9. Chat UI and chat logic      <- progressive (streamed) rendering lives here
    10. Memory, Profile and Settings screens
    11. Boot

   Replies come from ONE place: the Vercel function in /api/chat, which streams
   from Groq. Transport code is in chat-api.js. How Kashvee behaves (system
   prompt, models) is configured server-side in api/_config.js.
   ========================================================================== */
'use strict';

/* 0. Utilities ------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUP_GAP_MS = 5 * 60 * 1000;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Tiny DOM builder: h('div', { class: 'x', onClick }, child, 'text'). */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function formatDay(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now - 86400000)) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatRelative(ts) {
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* 1. Personality configuration -------------------------------------------- */
/*
   UI metadata only: what the interface shows about Kashvee. It does NOT generate
   replies. How Kashvee actually responds is decided server-side (api/_config.js).
*/
const KASHVEE_PERSONALITY = {
  name: 'Kashvee',
  tagline: 'Your AI companion, always ready to talk.',
  traits: ['Warm', 'Natural', 'Playful', 'Supportive', 'Honest', 'Consistent'],
  statusText: { online: 'Online', typing: 'Typing…', listening: 'Listening…' },

  suggestions: [
    { label: 'Say hello', text: 'Hi Kashvee!' },
    { label: 'Ask for honest advice', text: 'Can I get your honest advice on something?' },
    { label: 'What do you remember?', text: 'What do you remember about me?' }
  ],

  // Shown in Profile. The selected value is sent to the server as a user preference.
  tones: [
    { value: 'balanced', label: 'Balanced' },
    { value: 'warm', label: 'Warm' },
    { value: 'direct', label: 'Direct' },
    { value: 'playful', label: 'Playful' }
  ]
};

/* 2. Storage adapter ------------------------------------------------------- */
/*
   The only code that touches localStorage. To move to a real database later,
   keep these four methods (read, write, remove, clearAll) and change what is inside.
*/
const StorageAdapter = {
  prefix: 'kashvee:v1:',
  persistent: true,
  fallback: new Map(),

  init() {
    try {
      const probe = this.prefix + '__probe';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      this.persistent = true;
    } catch (err) {
      this.persistent = false; // blocked or unavailable: keep data in memory for this session
    }
    return this.persistent;
  },

  read(key, fallback = null) {
    try {
      const raw = this.persistent ? window.localStorage.getItem(this.prefix + key) : this.fallback.get(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  },

  write(key, value) {
    try {
      const raw = JSON.stringify(value);
      if (this.persistent) window.localStorage.setItem(this.prefix + key, raw);
      else this.fallback.set(key, raw);
      return true;
    } catch (err) {
      return false; // quota exceeded or storage blocked
    }
  },

  remove(key) {
    try {
      if (this.persistent) window.localStorage.removeItem(this.prefix + key);
      else this.fallback.delete(key);
    } catch (err) { /* ignore */ }
  },

  clearAll() {
    try {
      if (this.persistent) {
        const keys = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(this.prefix)) keys.push(k);
        }
        keys.forEach((k) => window.localStorage.removeItem(k));
      }
      this.fallback.clear();
    } catch (err) { /* ignore */ }
  }
};

/* 3. Memory layer ---------------------------------------------------------- */
/*
   Everything the app saves goes through these functions. Nothing else in the
   app reads or writes storage directly.
*/
const DEFAULTS = {
  profile: { name: '', interests: '' },
  prefs: { tone: 'balanced', length: 'balanced' },
  settings: { theme: 'dark', notifications: false, showStatus: true, showTyping: true, autoMemory: true, enterToSend: true }
};

const LIMITS = { memories: 200, memoryLength: 200, messagesPerConversation: 500, conversations: 50 };

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/* Profile, preferences, settings */
const loadProfile = () => ({ ...DEFAULTS.profile, ...asObject(StorageAdapter.read('profile', {})) });
const saveProfile = (profile) => StorageAdapter.write('profile', profile);
const loadPrefs = () => ({ ...DEFAULTS.prefs, ...asObject(StorageAdapter.read('prefs', {})) });
const savePrefs = (prefs) => StorageAdapter.write('prefs', prefs);
const loadSettings = () => ({ ...DEFAULTS.settings, ...asObject(StorageAdapter.read('settings', {})) });
const saveSettings = (settings) => StorageAdapter.write('settings', settings);

/* Memories */
function getMemories() {
  const list = StorageAdapter.read('memories', []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string')
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Returns { status: 'saved' | 'duplicate' | 'full' | 'invalid' | 'failed', entry? } */
function saveMemory({ text, kind = 'note', source = 'manual' }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.memoryLength);
  if (clean.length < 2) return { status: 'invalid' };
  const list = getMemories();
  const existing = list.find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (existing) return { status: 'duplicate', entry: existing };
  if (list.length >= LIMITS.memories) return { status: 'full' };
  const entry = { id: uid(), text: clean, kind, source, createdAt: Date.now() };
  list.unshift(entry);
  return StorageAdapter.write('memories', list) ? { status: 'saved', entry } : { status: 'failed', entry };
}

/** Removes one memory and returns it (so the UI can offer Undo), or null. */
function deleteMemory(id) {
  const list = getMemories();
  const index = list.findIndex((m) => m.id === id);
  if (index === -1) return null;
  const [removed] = list.splice(index, 1);
  StorageAdapter.write('memories', list);
  return removed;
}

function restoreMemory(entry) {
  const list = getMemories().filter((m) => m.id !== entry.id);
  list.push(entry);
  return StorageAdapter.write('memories', list);
}

const clearMemories = () => StorageAdapter.write('memories', []);

/** Finds the memory that best matches a phrase like "I like jazz". */
function findMemory(query) {
  const q = toSecondPerson(query).toLowerCase().replace(/[.!?]+$/, '').trim();
  if (q.length < 3) return null;
  const list = getMemories();
  const direct = list.find((m) => m.text.toLowerCase().includes(q));
  if (direct) return direct;
  const tokens = q.split(/\W+/).filter((t) => t.length > 2);
  if (!tokens.length) return null;
  return list.find((m) => tokens.every((t) => m.text.toLowerCase().includes(t))) || null;
}

/* Conversations */
function loadConversations() {
  const list = StorageAdapter.read('conversations', []);
  return Array.isArray(list)
    ? list.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages)).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
}

function createConversation() {
  const now = Date.now();
  return { id: uid(), title: 'New conversation', createdAt: now, updatedAt: now, messages: [] };
}

/** Saves a conversation. An empty conversation is removed from storage. Returns false if storage failed. */
function saveConversation(conversation) {
  let list = loadConversations().filter((c) => c.id !== conversation.id);
  if (conversation.messages.length) {
    if (conversation.messages.length > LIMITS.messagesPerConversation) {
      conversation.messages = conversation.messages.slice(-LIMITS.messagesPerConversation);
    }
    list.push(conversation);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    list = list.slice(0, LIMITS.conversations);
  }
  return StorageAdapter.write('conversations', list);
}

/** Loads a conversation by id, or the one that was last active, or the most recent one. */
function loadConversation(id) {
  const list = loadConversations();
  if (id) return list.find((c) => c.id === id) || null;
  const activeId = StorageAdapter.read('activeConversation', null);
  return list.find((c) => c.id === activeId) || list[0] || null;
}

const setActiveConversation = (id) => StorageAdapter.write('activeConversation', id);
const clearAllConversations = () => { StorageAdapter.write('conversations', []); StorageAdapter.remove('activeConversation'); };

function getStats() {
  const conversations = loadConversations();
  return {
    memories: getMemories().length,
    conversations: conversations.length,
    messages: conversations.reduce((sum, c) => sum + c.messages.length, 0)
  };
}

const resetAll = () => StorageAdapter.clearAll();

/* 4. Memory capture and AI bridge ------------------------------------------ */
/*
   MemoryCapture is the existing memory feature, unchanged in behaviour: it spots
   "remember that...", "forget...", a stated name, simple likes/dislikes and
   simple facts, and saves them through the Memory layer. It never writes replies.

   generateKashveeResponse(message, context, { signal, onDelta }) is the one
   function the chat calls to get a reply. It streams from /api/chat.
   context = { profile, prefs, memories, history, effects }
*/

const STOPWORDS = new Set((
  'about above after again also always another because been before being between both but can could did does doing done down during each ' +
  'even every from further had has have having her here him his how into its just like made make many more most much must myself need ' +
  'never only other our out over really same she should some such than that the their them then there these they this those through ' +
  'too under until very want was were what when where which while who will with would you your yours really think thing things know ' +
  'going gonna got get getting today tonight tomorrow yesterday something anything everything'
).split(' '));

const NAME_FILLER = new Set(['and', 'but', 'please', 'pls', 'thanks', 'though', 'so', 'btw', 'okay', 'ok']);
const NAME_BLOCK = new Set(['later', 'back', 'tomorrow', 'tonight', 'now', 'soon', 'maybe', 'when', 'if', 'anything', 'crazy', 'names', 'not', 'a', 'an', 'the', 'whenever', 'anytime', 'stupid']);

const RX = {
  forget: /^\s*(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.{3,200}?)\s*[.!]*\s*$/i,
  remember: /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?remember\s+(?:that\s+|this[:,]?\s+)?(.{3,200}?)\s*[.!]*\s*$/i,
  rememberBare: /^\s*(?:please\s+)?remember(?:\s+(?:this|that|something))?\s*[.!?]*\s*$/i,
  preference: /\bi(?:'m| am)?\s+(?:(don'?t|do not|never)\s+)?(?:(?:really|absolutely|totally|kinda|honestly|just)\s+)?(love|like|enjoy|prefer|hate|dislike|can'?t stand|cant stand|into|obsessed with)\s+([^.!?\n]{3,80})/i
};

const FACT_PATTERNS = [
  { re: /\bi(?:'m| am) from ([^.,!?;]{2,40})/i, build: (a) => `You're from ${a}.` },
  { re: /\bi live in ([^.,!?;]{2,40})/i, build: (a) => `You live in ${a}.` },
  { re: /\bi work (as|at|for) ([^.,!?;]{2,40})/i, build: (a, b) => `You work ${a} ${b}.` },
  { re: /\bi study ([^.,!?;]{2,40})/i, build: (a) => `You study ${a}.` },
  { re: /\bi(?:'m| am) studying ([^.,!?;]{2,40})/i, build: (a) => `You study ${a}.` },
  { re: /\bmy birthday is ([^.,!?;]{2,30})/i, build: (a) => `Your birthday is ${a}.` },
  { re: /\bmy (?:favorite|favourite) ([a-z ]{2,24}) is ([^.,!?;]{2,40})/i, build: (a, b) => `Your favorite ${a.trim()} is ${b}.`, kind: 'preference' }
];

/* First-person to second-person, so memories read as "You like..." */
function toSecondPerson(text) {
  return String(text)
    .replace(/\bI'm\b/gi, "you're").replace(/\bI am\b/gi, 'you are').replace(/\bI've\b/gi, "you've")
    .replace(/\bI'll\b/gi, "you'll").replace(/\bI'd\b/gi, "you'd").replace(/\bI\b/g, 'you')
    .replace(/\bmyself\b/gi, 'yourself').replace(/\bmine\b/gi, 'yours').replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you')
    .replace(/\byou was\b/gi, 'you were')
    .trim();
}

function asSentence(text) {
  let s = String(text).trim().replace(/[.!?\s]+$/, '');
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s + '.';
}

const trimClause = (s) => String(s).split(/\s+(?:and|but|because|so|though|although|which)\s+/i)[0].trim();

const MemoryCapture = {
  /** Finds memory-related intent in a message. Pure: no side effects. */
  analyze(message) {
    const text = String(message || '').trim();
    let m;

    if ((m = text.match(RX.forget))) {
      const query = m[1].trim();
      if (!['it', 'that', 'this', 'about it'].includes(query.toLowerCase())) return { intent: 'forget', data: { query } };
    }
    if ((m = text.match(RX.remember)) && !m[1].includes('?')) return { intent: 'remember', data: { raw: m[1].trim() } };
    if (RX.rememberBare.test(text)) return { intent: 'rememberEmpty' };

    const name = this.parseName(text);
    if (name) return { intent: 'nameShared', data: { name } };

    const pref = this.parsePreference(text);
    if (pref) return { intent: pref.positive ? 'preferenceLike' : 'preferenceDislike', data: pref };

    const fact = this.parseFact(text);
    if (fact) return { intent: 'fact', data: fact };

    return { intent: 'none' };
  },

  parseName(text) {
    let raw = '';
    let m = text.match(/\bmy name(?:'s| is)\s+([A-Za-z][A-Za-z'’-]{1,24}(?:\s+[A-Za-z][A-Za-z'’-]{1,24})?)/i);
    if (m) raw = m[1];
    if (!raw) {
      m = text.match(/\b(?:call me|you can call me|i(?:'m| am) called)\s+([A-Za-z][A-Za-z'’-]{1,24})/i);
      if (m) raw = m[1];
    }
    if (!raw) return '';
    const words = [];
    for (const word of raw.split(/\s+/)) {
      if (NAME_FILLER.has(word.toLowerCase())) break;
      words.push(word);
    }
    if (!words.length || NAME_BLOCK.has(words[0].toLowerCase())) return '';
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  },

  parsePreference(text) {
    const m = text.match(RX.preference);
    if (!m || text.includes('?')) return null;
    const negated = Boolean(m[1]);
    const verb = m[2].toLowerCase().replace(/^cant/, "can't");
    let object = trimClause(m[3]).replace(/\s+(too|a lot|so much|very much|though|lately)$/i, '').trim();
    if (object.length < 3 || /^(it|that|this|them|him|her|you|when|how|what)\b/i.test(object)) return null;
    object = toSecondPerson(object);
    const positiveVerb = ['love', 'like', 'enjoy', 'prefer', 'into', 'obsessed with'].includes(verb);
    const positive = positiveVerb && !negated;
    const phrase = { into: 'are into', 'obsessed with': 'are obsessed with' }[verb] || verb;
    const verbText = negated ? `don't ${phrase}` : phrase;
    return { positive, text: `You ${verbText} ${object}.` };
  },

  parseFact(text) {
    for (const pattern of FACT_PATTERNS) {
      const m = text.match(pattern.re);
      if (!m) continue;
      const parts = m.slice(1).map(trimClause);
      if (parts.some((p) => p.length < 2)) continue;
      return { text: pattern.build(...parts), kind: pattern.kind || 'fact' };
    }
    return null;
  },

  /** What, if anything, should be saved to memory from this message. */
  extractMemories(message, analysis = this.analyze(message)) {
    const out = [];
    if (analysis.intent === 'remember') {
      const raw = analysis.data.raw;
      const text = /^to\s/i.test(raw) ? asSentence(`Remember ${raw}`) : asSentence(toSecondPerson(raw));
      if (text) out.push({ text, kind: 'note' });
    } else if (analysis.intent === 'preferenceLike' || analysis.intent === 'preferenceDislike') {
      out.push({ text: analysis.data.text, kind: 'preference' });
    } else if (analysis.intent === 'fact') {
      out.push({ text: analysis.data.text, kind: analysis.data.kind });
    }
    return out;
  }
};

/* Which memories travel with a chat request. Bounded: never the whole store. */
const CONTEXT_LIMITS = { history: 12, relevantMemories: 12, recentMemories: 8 };

const contentWords = (text) => (String(text).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));

/** Memories that share words with the message (best first), topped up with the newest ones. */
function selectMemoriesForContext(message, memories) {
  const tokens = new Set(contentWords(message));
  const scored = memories.map((m, index) => {
    const words = new Set(contentWords(m.text));
    let score = 0;
    tokens.forEach((t) => { if (words.has(t)) score += 1; });
    return { m, index, score };
  });
  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index) // memories are newest-first
    .slice(0, CONTEXT_LIMITS.relevantMemories);
  const picked = new Set(relevant.map((s) => s.index));
  const recent = scored.filter((s) => !picked.has(s.index)).slice(0, CONTEXT_LIMITS.recentMemories);
  return [...relevant, ...recent].map((s) => s.m.text);
}

/** Plain-language notes about what the app just did, so the model doesn't contradict it. */
function describeEffects(effects = {}) {
  const notes = [];
  if (effects.saved && effects.saved.length) notes.push(`The app saved this to the user's Memory tab: "${effects.saved[0].text}"`);
  if (effects.duplicate) notes.push('The user asked to remember something that was already saved.');
  if (effects.full) notes.push('The user asked to remember something, but the Memory tab is full, so it was not saved.');
  if (effects.rememberEmpty) notes.push('The user asked to remember something but did not say what.');
  if (effects.forgot) notes.push('The app removed a saved memory at the user\'s request.');
  if (effects.forgetMissed) notes.push('The user asked to forget something, but no matching saved memory was found.');
  return notes;
}

/**
 * THE ONE CHAT-GENERATION PATH. Streams the reply from /api/chat.
 * Resolves { text, truncated }. Rejects with a ChatError, or an AbortError if
 * `signal` was aborted. There is deliberately no offline/mock fallback.
 */
async function generateKashveeResponse(message, context = {}, { signal, onDelta } = {}) {
  if (!window.KashveeChatAPI) throw new Error('chat-api.js did not load');
  return window.KashveeChatAPI.stream({
    message,
    history: (context.history || []).map((m) => ({ role: m.role, text: m.text })),
    context: {
      profile: context.profile,
      prefs: context.prefs,
      memories: context.memories,
      notes: describeEffects(context.effects)
    }
  }, { signal, onDelta });
}

/* 5. Voice ----------------------------------------------------------------- */

const Voice = {
  Ctor: (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null,
  recognition: null,
  listening: false,

  get supported() { return Boolean(this.Ctor); },

  messageFor(code) {
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
        return 'Microphone access is blocked. Allow it in your browser’s site settings and try again. Some browsers also block the mic on files opened directly from your device.';
      case 'no-speech': return "I didn't hear anything. Tap the mic and try again.";
      case 'audio-capture': return 'No microphone was found on this device.';
      case 'network': return 'Voice recognition needs an internet connection in this browser.';
      case 'language-not-supported': return "This browser can't recognize speech in your language.";
      default: return "Voice input stopped unexpectedly. You can still type your message.";
    }
  },

  start({ onResult, onState, onError }) {
    if (!this.supported) {
      onError("Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type your message.");
      return false;
    }
    if (this.listening) return true;
    let recognition;
    try {
      recognition = new this.Ctor();
      recognition.lang = navigator.language || 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => { this.listening = true; onState(true); };
      recognition.onresult = (event) => {
        const results = Array.from(event.results);
        const transcript = results.map((r) => r[0].transcript).join(' ').trim();
        onResult(transcript, results[results.length - 1].isFinal);
      };
      recognition.onerror = (event) => { if (event.error !== 'aborted') onError(this.messageFor(event.error)); };
      recognition.onend = () => { this.listening = false; this.recognition = null; onState(false); };
      this.recognition = recognition;
      recognition.start();
      return true;
    } catch (err) {
      this.listening = false;
      this.recognition = null;
      onError('Voice input could not start. You can still type your message.');
      return false;
    }
  },

  stop() {
    try { if (this.recognition) this.recognition.stop(); } catch (err) { /* ignore */ }
  }
};

/* 6. App state ------------------------------------------------------------- */

const State = {
  profile: { ...DEFAULTS.profile },
  prefs: { ...DEFAULTS.prefs },
  settings: { ...DEFAULTS.settings },
  conversation: null,
  pending: 0,
  renderLimit: 100,
  storageWarned: false,

  load() {
    this.profile = loadProfile();
    this.prefs = loadPrefs();
    this.settings = loadSettings();
    this.conversation = loadConversation() || createConversation();
    this.renderLimit = 100;
  }
};

function persistConversation(conv = State.conversation) {
  const ok = saveConversation(conv);
  setActiveConversation(conv.id);
  if ((!ok || !StorageAdapter.persistent) && !State.storageWarned) {
    State.storageWarned = true;
    Toast.show(StorageAdapter.persistent
      ? 'Storage is full, so new messages may not be saved. Clear old conversations in Settings.'
      : "Your browser is blocking storage, so this chat won't be saved after you close it.", { duration: 6000 });
  }
}

/* 7. UI primitives --------------------------------------------------------- */

const Toast = {
  root: null,
  init() { this.root = $('#toasts'); },
  show(message, { actionLabel, onAction, duration = 3600 } = {}) {
    if (!this.root) return;
    while (this.root.children.length >= 3) this.root.firstElementChild.remove();
    let timer = null;
    const remove = () => {
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 220);
    };
    const node = h('div', { class: 'toast' },
      h('span', { text: message }),
      actionLabel ? h('button', { type: 'button', class: 'toast-action', onClick: () => { if (onAction) onAction(); remove(); } }, actionLabel) : null);
    this.root.append(node);
    timer = setTimeout(remove, duration);
  }
};

const Modal = {
  root: null,
  resolver: null,
  lastFocus: null,

  init() {
    this.root = $('#modal');
    this.title = $('#modal-title');
    this.body = $('#modal-body');
    this.cancel = $('#modal-cancel');
    this.confirmBtn = $('#modal-confirm');
    this.cancel.addEventListener('click', () => this.close(false));
    this.confirmBtn.addEventListener('click', () => this.close(true));
    $('.modal-backdrop', this.root).addEventListener('click', () => this.close(false));
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close(false);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const order = [this.cancel, this.confirmBtn];
        const i = order.indexOf(document.activeElement);
        order[(i + (event.shiftKey ? -1 : 1) + order.length) % order.length].focus();
      }
    });
  },

  /** Resolves true if the person confirms, false if they cancel. Focus starts on Cancel. */
  confirm({ title, body, confirmLabel = 'Confirm' }) {
    if (this.resolver) this.close(false);
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.lastFocus = document.activeElement;
      this.title.textContent = title;
      this.body.textContent = body;
      this.confirmBtn.textContent = confirmLabel;
      this.root.hidden = false;
      this.cancel.focus();
    });
  },

  close(result) {
    if (!this.resolver) return;
    const resolve = this.resolver;
    this.resolver = null;
    this.root.hidden = true;
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus({ preventScroll: true });
    resolve(result);
  }
};

/* Keeps the layout correct when the mobile keyboard opens. */
const Viewport = {
  baseHeight: 0,
  baseWidth: 0,

  init() {
    const vv = window.visualViewport;
    const update = () => {
      const stick = ChatUI.isNearBottom();
      const height = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      if (window.innerWidth !== this.baseWidth) {
        this.baseWidth = window.innerWidth;
        this.baseHeight = height;
      }
      this.baseHeight = Math.max(this.baseHeight, height);
      const root = document.documentElement;
      root.style.setProperty('--app-h', `${height}px`);
      root.style.setProperty('--app-top', `${top}px`);
      document.body.classList.toggle('kb-open', window.innerWidth < 860 && this.baseHeight - height > 140);
      if (top) window.scrollTo(0, 0);
      if (stick) requestAnimationFrame(() => ChatUI.scrollToBottom(false));
    };
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(() => { this.baseHeight = 0; update(); }, 250));
    update();
  }
};

const Notify = {
  supported: () => typeof window !== 'undefined' && 'Notification' in window,

  async enable() {
    if (!this.supported()) return { ok: false, message: "This browser doesn't support notifications." };
    if (Notification.permission === 'granted') return { ok: true };
    if (Notification.permission === 'denied') return { ok: false, message: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.' };
    try {
      const result = await Notification.requestPermission();
      return result === 'granted' ? { ok: true } : { ok: false, message: 'Notification permission was not granted.' };
    } catch (err) {
      return { ok: false, message: "Couldn't ask for notification permission here." };
    }
  },

  send(body) {
    if (!State.settings.notifications || !this.supported() || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      new Notification(KASHVEE_PERSONALITY.name, { body: truncate(body, 120), icon: 'assets/avatar.svg', tag: 'kashvee-reply' });
    } catch (err) { /* some browsers only allow notifications from a service worker */ }
  }
};

function applyTheme() {
  const pref = State.settings.theme;
  const resolved = pref === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : (pref === 'light' ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#F5F5F9' : '#0A0A0C');
}

function applyStatusVisibility() {
  document.body.classList.toggle('hide-status', !State.settings.showStatus);
}

/* 8. Views and navigation -------------------------------------------------- */

const Views = {
  list: [
    { id: 'chat', label: 'Chat' },
    { id: 'memory', label: 'Memory' },
    { id: 'profile', label: 'Profile' },
    { id: 'settings', label: 'Settings' }
  ],
  current: 'chat',

  init() {
    $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => this.go(btn.dataset.view)));
    window.addEventListener('hashchange', () => this.show(this.fromHash(), { focus: true }));
    this.show(this.fromHash(), { focus: false });
  },

  fromHash() {
    const id = window.location.hash.replace('#', '');
    return this.list.some((v) => v.id === id) ? id : 'chat';
  },

  /** Changes the hash so the browser Back button moves between tabs. */
  go(id) {
    if (window.location.hash === `#${id}` || (id === 'chat' && !window.location.hash)) {
      this.show(id, { focus: true });
      return;
    }
    window.location.hash = id;
  },

  show(id, { focus = true } = {}) {
    this.current = id;
    $$('.view').forEach((view) => { view.hidden = view.dataset.view !== id; });
    $$('.nav-btn').forEach((btn) => {
      if (btn.dataset.view === id) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    const label = this.list.find((v) => v.id === id).label;
    document.title = id === 'chat' ? KASHVEE_PERSONALITY.name : `${label} · ${KASHVEE_PERSONALITY.name}`;

    if (id === 'chat') ChatUI.scrollToBottom(false);
    if (id === 'memory') MemoryUI.render();
    if (id === 'profile') ProfileUI.render();
    if (id === 'settings') SettingsUI.sync();

    const scroller = $(`#view-${id} .page-scroll`);
    if (scroller) scroller.scrollTop = 0;
    if (focus && id !== 'chat') {
      const heading = $(`#view-${id} [data-heading]`);
      if (heading) heading.focus({ preventScroll: true });
    }
  }
};

/* 9. Chat UI and chat logic ------------------------------------------------ */

const ChatUI = {
  els: {},
  lastMsg: null,
  lastEl: null,
  noticeEl: null,
  stream: null, // the assistant bubble currently being streamed, if any

  init() {
    const P = KASHVEE_PERSONALITY;
    const els = this.els = {
      messages: $('#messages'), thread: $('#thread'), welcome: $('#welcome'), typing: $('#typing'),
      form: $('#composer'), input: $('#message-input'), send: $('#send-btn'), mic: $('#mic-btn'),
      attach: $('#attach-btn'), status: $('#chat-status'), jump: $('#jump-btn'),
      newChat: $('#new-chat-btn'), suggestions: $('#suggestions')
    };

    P.suggestions.forEach((s) => {
      els.suggestions.append(h('button', { type: 'button', class: 'chip', onClick: () => this.sendText(s.text) }, s.label));
    });

    els.form.addEventListener('submit', (event) => { event.preventDefault(); this.submit(); });
    els.input.addEventListener('input', () => { this.autosize(); this.updateSend(); });
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && State.settings.enterToSend) {
        event.preventDefault();
        this.submit();
      }
    });
    els.input.addEventListener('focus', () => {
      setTimeout(() => { if (this.isNearBottom()) this.scrollToBottom(false); }, 300);
    });
    // Keep the keyboard open when tapping Send.
    els.send.addEventListener('mousedown', (event) => event.preventDefault());

    els.attach.addEventListener('click', () => Toast.show('Attachments are coming soon. Kashvee handles text for now.'));
    els.mic.addEventListener('click', () => this.toggleMic());
    if (!Voice.supported) els.mic.classList.add('is-unsupported');

    els.newChat.addEventListener('click', () => Chat.newConversation());
    els.jump.addEventListener('click', () => this.scrollToBottom(true));
    let ticking = false;
    els.messages.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; this.updateJump(); });
    }, { passive: true });

    this.renderAll();
    this.refreshStatus();
  },

  /* Composer */
  autosize() {
    const input = this.els.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  },

  updateSend() { this.els.send.disabled = !this.els.input.value.trim(); },

  submit() {
    const { input } = this.els;
    const text = input.value.trim();
    if (!text) return;
    Voice.stop();
    input.value = '';
    this.autosize();
    this.updateSend();
    Chat.send(text);
    input.focus({ preventScroll: true });
  },

  sendText(text) {
    Chat.send(text);
  },

  toggleMic() {
    const { input } = this.els;
    if (!Voice.supported) {
      Toast.show("Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type your message.");
      return;
    }
    if (Voice.listening) { Voice.stop(); return; }
    const base = input.value.trim() ? `${input.value.trimEnd()} ` : '';
    Voice.start({
      onResult: (text) => { input.value = base + text; this.autosize(); this.updateSend(); },
      onState: (on) => this.setListening(on),
      onError: (message) => Toast.show(message, { duration: 5500 })
    });
  },

  setListening(on) {
    const { mic, input } = this.els;
    mic.classList.toggle('is-listening', on);
    mic.setAttribute('aria-pressed', String(on));
    mic.setAttribute('aria-label', on ? 'Stop voice input' : 'Start voice input');
    this.refreshStatus();
    if (!on && input.value.trim()) input.focus({ preventScroll: true });
  },

  /* Status line and typing indicator */
  refreshStatus() {
    const P = KASHVEE_PERSONALITY;
    const { status, typing } = this.els;
    const typingOn = State.pending > 0 && State.settings.showTyping;
    const streaming = Boolean(Chat.active && Chat.active.started);
    const stick = this.isNearBottom();
    typing.hidden = !typingOn || streaming; // dots only until the first token arrives
    if (!typing.hidden && stick) this.scrollToBottom(false);
    status.textContent = Voice.listening ? P.statusText.listening
      : (typingOn ? P.statusText.typing : P.statusText.online);
  },

  /* Rendering */
  renderAll({ scroll = true } = {}) {
    const { thread } = this.els;
    thread.replaceChildren();
    this.lastMsg = null;
    this.lastEl = null;
    this.noticeEl = null;
    const all = State.conversation.messages;
    const start = Math.max(0, all.length - State.renderLimit);
    if (start > 0) {
      thread.append(h('button', { type: 'button', class: 'load-earlier', onClick: () => this.loadEarlier() }, `Show earlier messages (${start})`));
    }
    for (let i = start; i < all.length; i += 1) this.addNodes(all[i], i > start ? all[i - 1] : null, false);
    if (this.stream) {
      thread.append(this.stream.el);
      this.lastMsg = this.stream.draft;
      this.lastEl = this.stream.el;
    }
    this.updateEmpty();
    if (scroll) this.scrollToBottom(false);
  },

  loadEarlier() {
    const { messages } = this.els;
    const oldTop = messages.scrollTop;
    const oldHeight = messages.scrollHeight;
    State.renderLimit += 100;
    this.renderAll({ scroll: false });
    messages.scrollTop = oldTop + (messages.scrollHeight - oldHeight);
  },

  addNodes(msg, prev, animate) {
    const { thread } = this.els;
    const P = KASHVEE_PERSONALITY;
    if (!prev || !sameDay(prev.ts, msg.ts)) {
      thread.append(h('div', { class: 'day-divider', role: 'separator' }, h('span', { text: formatDay(msg.ts) })));
    }
    const grouped = Boolean(prev && prev.role === msg.role && msg.ts - prev.ts < GROUP_GAP_MS && sameDay(prev.ts, msg.ts));
    if (grouped && this.lastEl) this.lastEl.classList.remove('is-last');
    const isUser = msg.role === 'user';
    const el = h('div', { class: ['msg', isUser ? 'msg--user' : 'msg--kashvee', grouped ? 'is-grouped' : '', 'is-last', animate ? 'is-new' : ''].filter(Boolean).join(' ') },
      h('div', { class: 'bubble' }, h('span', { class: 'sr-only', text: isUser ? 'You: ' : `${P.name}: ` }), msg.text),
      ...this.noteNodes(msg),
      h('time', { class: 'msg-time', datetime: new Date(msg.ts).toISOString(), text: formatTime(msg.ts) }));
    thread.append(el);
    this.lastMsg = msg;
    this.lastEl = el;
  },

  /** Small captions under a bubble: a memory action and/or an incomplete-reply warning. */
  noteNodes(msg) {
    const status = { interrupted: 'This reply was interrupted and may be incomplete.', truncated: 'This reply hit the length limit and may be cut off.' }[msg.status];
    return [
      msg.note ? h('div', { class: 'msg-note' }, icon('bookmark'), h('span', { text: msg.note })) : null,
      status ? h('div', { class: 'msg-note' }, h('span', { text: status })) : null
    ];
  },

  append(msg, { animate = true, forceScroll = false } = {}) {
    const wasNear = this.isNearBottom();
    this.addNodes(msg, this.lastMsg, animate);
    this.updateEmpty();
    if (forceScroll || wasNear) this.scrollToBottom(animate);
    else this.updateJump();
  },

  /* Streaming: one bubble is created on the first chunk, updated in place, then finalized. */
  beginStream() {
    const wasNear = this.isNearBottom();
    const draft = { id: uid(), role: 'kashvee', text: '', ts: Date.now() };
    this.addNodes(draft, this.lastMsg, true);
    const el = this.lastEl;
    const bubble = $('.bubble', el);
    el.classList.add('is-streaming');
    this.stream = { draft, el, bubble, textNode: bubble.lastChild, text: '', raf: 0, stick: wasNear };
    this.updateEmpty();
    if (wasNear) this.scrollToBottom(false);
    else this.updateJump();
  },

  /** Cheap per-chunk update: batches to one DOM write per frame and never uses innerHTML. */
  updateStream(text) {
    const s = this.stream;
    if (!s) return;
    s.text = text;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (this.stream !== s) return;
      s.stick = this.isNearBottom();
      s.textNode.data = s.text;
      if (s.stick) this.scrollToBottom(false);
      else this.updateJump();
    });
  },

  /** Turns the streaming bubble into the final message in place (no duplicate bubble). */
  finishStream(msg) {
    const s = this.stream;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    // Replacing the text node lets screen readers announce the finished reply once.
    s.bubble.replaceChildren(s.bubble.firstChild, document.createTextNode(msg.text));
    s.el.classList.remove('is-streaming');
    const time = $('.msg-time', s.el);
    this.noteNodes(msg).forEach((node) => { if (node) s.el.insertBefore(node, time); });
    this.lastMsg = msg;
    this.lastEl = s.el;
    this.stream = null;
    if (s.stick) this.scrollToBottom(false);
    else this.updateJump();
  },

  /** Drops an unfinished bubble (conversation switched or cleared). */
  discardStream() {
    const s = this.stream;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.el.remove();
    this.stream = null;
  },

  updateEmpty() {
    const empty = State.conversation.messages.length === 0;
    this.els.welcome.hidden = !empty;
  },

  showNotice(text, onRetry) {
    this.clearNotice();
    const wasNear = this.isNearBottom();
    this.noticeEl = h('div', { class: 'notice', role: 'alert' },
      h('span', { text }),
      h('button', { type: 'button', onClick: () => onRetry() }, 'Try again'));
    this.els.thread.append(this.noticeEl);
    if (wasNear) this.scrollToBottom(false);
  },

  clearNotice() {
    if (this.noticeEl) { this.noticeEl.remove(); this.noticeEl = null; }
  },

  /* Scrolling */
  isNearBottom() {
    const m = this.els.messages;
    if (!m) return true;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  },

  scrollToBottom(smooth) {
    const m = this.els.messages;
    if (!m) return;
    m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.els.jump.hidden = true;
  },

  updateJump() {
    const m = this.els.messages;
    this.els.jump.hidden = m.scrollHeight - m.scrollTop - m.clientHeight < 260;
  }
};

const Chat = {
  queue: Promise.resolve(),
  epoch: 0,     // bumped whenever the conversation is replaced or cleared; stale work checks it and stops
  active: null, // the generation in flight: { controller, epoch, started }

  send(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    ChatUI.clearNotice();
    const conv = State.conversation;
    const userMsg = { id: uid(), role: 'user', text, ts: Date.now() };
    conv.messages.push(userMsg);
    if (conv.messages.length === 1) conv.title = truncate(text, 48);
    conv.updatedAt = userMsg.ts;
    persistConversation(conv);
    ChatUI.append(userMsg, { animate: true, forceScroll: true });
    this.enqueue(conv, userMsg, this.applyEffects(text));
  },

  /** Replies run one at a time, in order, so two streams never write at once. */
  enqueue(conv, userMsg, effects) {
    const epoch = this.epoch;
    this.queue = this.queue
      .then(() => this.reply(conv, userMsg, effects, epoch))
      .catch((err) => console.error('[Kashvee] reply queue error', err));
  },

  /** Saves memories, names and removals triggered by what the person said. */
  applyEffects(text) {
    const effects = { saved: [], note: '' };
    let analysis;
    try { analysis = MemoryCapture.analyze(text); } catch (err) { return effects; }

    if (analysis.intent === 'nameShared') {
      State.profile.name = analysis.data.name;
      saveProfile(State.profile);
      effects.note = 'Name saved to your profile';
    }

    if (analysis.intent === 'rememberEmpty') effects.rememberEmpty = true;

    if (analysis.intent === 'forget') {
      const match = findMemory(analysis.data.query);
      if (match) {
        const removed = deleteMemory(match.id);
        effects.forgot = Boolean(removed);
        if (removed) effects.note = 'Removed from memory';
      } else {
        effects.forgetMissed = true;
      }
    }

    const explicit = analysis.intent === 'remember';
    if (explicit || State.settings.autoMemory) {
      for (const candidate of MemoryCapture.extractMemories(text, analysis)) {
        const result = saveMemory({ ...candidate, source: 'chat' });
        if (result.status === 'saved') effects.saved.push(result.entry);
        else if (result.status === 'duplicate') effects.duplicate = true;
        else if (result.status === 'full') effects.full = true;
      }
    }
    if (effects.saved.length) effects.note = `Added to memory: ${truncate(effects.saved[0].text, 80)}`;
    return effects;
  },

  /** A bounded slice of the app's data for one request. Never the whole store. */
  buildContext(conv, userMsg, effects) {
    // Replies are stored after any user messages sent while they were generating, so "before this
    // message" can't be a simple slice. Keep every reply, drop this message and later unanswered ones.
    const index = conv.messages.findIndex((m) => m.id === userMsg.id);
    const cutoff = index === -1 ? conv.messages.length : index;
    const prior = conv.messages.filter((m, i) => m.id !== userMsg.id && (m.role !== 'user' || i < cutoff));
    return {
      profile: { ...State.profile },
      prefs: { ...State.prefs },
      memories: selectMemoriesForContext(userMsg.text, getMemories()),
      history: prior.slice(-CONTEXT_LIMITS.history),
      effects
    };
  },

  async reply(conv, userMsg, effects, epoch) {
    if (epoch !== this.epoch) return; // the conversation changed while this was queued
    ChatUI.clearNotice();

    const job = { controller: new AbortController(), epoch, started: false };
    this.active = job;
    State.pending += 1;
    ChatUI.refreshStatus();

    let text = '';
    let truncated = false;
    let failure = null;
    try {
      const result = await generateKashveeResponse(userMsg.text, this.buildContext(conv, userMsg, effects), {
        signal: job.controller.signal,
        onDelta: (chunk) => {
          if (job.epoch !== this.epoch || job.controller.signal.aborted) return; // late chunk from an old request
          text += chunk;
          if (!job.started) {
            job.started = true;
            ChatUI.beginStream();
            ChatUI.refreshStatus();
          }
          ChatUI.updateStream(text);
        }
      });
      truncated = result.truncated;
    } catch (err) {
      failure = err;
    }

    State.pending -= 1;
    if (this.active === job) this.active = null;
    if (epoch !== this.epoch) { ChatUI.refreshStatus(); return; } // cancelled: nothing may touch the new conversation

    const partial = text.trim();
    if (!failure && !partial) failure = { userMessage: "Kashvee couldn't reply just now." };

    if (partial) {
      const msg = ChatUI.stream ? ChatUI.stream.draft : { id: uid(), role: 'kashvee', ts: Date.now() };
      msg.text = partial;
      if (failure) msg.status = 'interrupted';
      else if (truncated) msg.status = 'truncated';
      if (effects.note) msg.note = effects.note;
      conv.messages.push(msg);
      conv.updatedAt = msg.ts;
      persistConversation(conv);
      if (ChatUI.stream) ChatUI.finishStream(msg);
      else ChatUI.append(msg, { animate: false });
      if (!failure) Notify.send(msg.text);
    }
    ChatUI.refreshStatus();

    if (failure) {
      console.error('[Kashvee] reply failed:', failure.code || failure.name || failure.message);
      const message = partial ? 'The reply was interrupted.' : (failure.userMessage || "Kashvee couldn't reply just now.");
      ChatUI.showNotice(message, () => this.retry(conv, userMsg));
    }
  },

  retry(conv, userMsg) {
    if (conv !== State.conversation) return;
    ChatUI.clearNotice();
    // Replace an interrupted partial reply instead of stacking a second answer under it.
    const index = conv.messages.findIndex((m) => m.id === userMsg.id);
    const next = conv.messages[index + 1];
    if (index !== -1 && next && next.role === 'kashvee' && next.status === 'interrupted') {
      conv.messages.splice(index + 1, 1);
      persistConversation(conv);
      ChatUI.renderAll();
    }
    this.enqueue(conv, userMsg, { saved: [], note: '' });
  },

  /** Stops any generation (running or queued) and invalidates everything started before this call. */
  cancelGeneration() {
    this.epoch += 1;
    if (this.active) {
      this.active.controller.abort();
      this.active = null;
    }
    ChatUI.discardStream();
    this.queue = Promise.resolve();
  },

  /* Conversation management */
  newConversation() {
    if (!State.conversation.messages.length) {
      Toast.show("You're already in a new conversation.");
      return;
    }
    this.swapTo(createConversation());
    Toast.show('Started a new conversation.');
  },

  open(id) {
    if (id === State.conversation.id) { Views.go('chat'); return; }
    const conv = loadConversation(id);
    if (!conv) { Toast.show("That conversation couldn't be found."); return; }
    this.swapTo(conv);
    Views.go('chat');
  },

  swapTo(conversation) {
    this.cancelGeneration();
    State.conversation = conversation;
    State.renderLimit = 100;
    setActiveConversation(conversation.id);
    ChatUI.clearNotice();
    ChatUI.renderAll();
    ChatUI.refreshStatus();
  },

  clearCurrent() {
    this.cancelGeneration();
    State.conversation.messages = [];
    State.conversation.title = 'New conversation';
    saveConversation(State.conversation);
    ChatUI.renderAll();
    ChatUI.refreshStatus();
  }
};


/* 10. Memory, Profile and Settings screens --------------------------------- */

const KIND_LABELS = { preference: 'Preference', fact: 'About you', note: 'Note' };

const MemoryUI = {
  init() {
    this.form = $('#memory-form');
    this.input = $('#memory-input');
    this.error = $('#memory-error');
    this.list = $('#memory-list');
    this.empty = $('#memory-empty');
    this.count = $('#memory-count');

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = saveMemory({ text: this.input.value, kind: 'note', source: 'manual' });
      if (result.status === 'invalid') return this.showError('Write something for Kashvee to remember.');
      if (result.status === 'duplicate') return this.showError('Kashvee already remembers that.');
      if (result.status === 'full') return this.showError(`Memory is full (${LIMITS.memories} items). Delete one to make room.`);
      if (result.status === 'failed') return this.showError("Your browser couldn't save this. Check that storage is allowed.");
      this.showError('');
      this.input.value = '';
      this.render();
      Toast.show('Memory saved.');
      return undefined;
    });
    this.input.addEventListener('input', () => this.showError(''));

    this.list.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-delete]');
      if (!btn) return;
      const removed = deleteMemory(btn.dataset.delete);
      if (!removed) return;
      this.render();
      Toast.show('Memory deleted.', {
        actionLabel: 'Undo',
        duration: 5000,
        onAction: () => { restoreMemory(removed); this.render(); }
      });
    });
  },

  showError(message) {
    this.error.textContent = message;
    this.error.hidden = !message;
  },

  render() {
    const memories = getMemories();
    this.empty.hidden = memories.length > 0;
    this.list.hidden = memories.length === 0;
    this.count.hidden = memories.length === 0;
    this.count.textContent = plural(memories.length, 'memory', 'memories');
    this.list.replaceChildren(...memories.map((m) => h('li', { class: 'memory-item' },
      h('div', { class: 'memory-main' },
        h('p', { class: 'memory-text', text: m.text }),
        h('p', { class: 'memory-meta' },
          h('span', { class: 'pill', text: KIND_LABELS[m.kind] || 'Note' }),
          h('span', { text: `${m.source === 'chat' ? 'From chat' : 'Added by you'}, ${formatRelative(m.createdAt)}` }))),
      h('button', { type: 'button', class: 'icon-btn icon-btn--quiet', 'data-delete': m.id, 'aria-label': `Delete memory: ${truncate(m.text, 60)}` }, icon('trash')))));
  }
};

const ProfileUI = {
  init() {
    const P = KASHVEE_PERSONALITY;
    this.form = $('#profile-form');
    this.name = $('#profile-name');
    this.interests = $('#profile-interests');
    this.tone = $('#profile-tone');
    this.convoList = $('#convo-list');
    this.convoEmpty = $('#convo-empty');

    $('#persona-name').textContent = P.name;
    $('#persona-tag').textContent = P.tagline;
    $('#persona-traits').replaceChildren(...P.traits.map((t) => h('li', { text: t })));
    this.tone.replaceChildren(...P.tones.map((t) => h('option', { value: t.value }, t.label)));

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const checked = $('input[name="length"]:checked', this.form);
      State.profile.name = this.name.value.replace(/\s+/g, ' ').trim().slice(0, 40);
      State.profile.interests = this.interests.value.replace(/\s+/g, ' ').trim().slice(0, 120);
      State.prefs.tone = this.tone.value;
      State.prefs.length = checked ? checked.value : 'balanced';
      const ok = saveProfile(State.profile) && savePrefs(State.prefs);
      Toast.show(ok ? 'Profile saved.' : "Your browser couldn't save this. Check that storage is allowed.");
      this.render();
    });
  },

  render() {
    const stats = getStats();
    $('#stat-memories').textContent = stats.memories;
    $('#stat-conversations').textContent = stats.conversations;
    $('#stat-messages').textContent = stats.messages;

    this.name.value = State.profile.name;
    this.interests.value = State.profile.interests;
    this.tone.value = State.prefs.tone;
    $$('input[name="length"]', this.form).forEach((r) => { r.checked = r.value === State.prefs.length; });

    const conversations = loadConversations().slice(0, 10);
    this.convoEmpty.hidden = conversations.length > 0;
    this.convoList.hidden = conversations.length === 0;
    this.convoList.replaceChildren(...conversations.map((c) => {
      const current = c.id === State.conversation.id;
      return h('li', {},
        h('button', { type: 'button', class: 'row row--button', onClick: () => Chat.open(c.id) },
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title', text: c.title }),
            h('span', { class: 'row-sub', text: `${plural(c.messages.length, 'message', 'messages')}, ${formatRelative(c.updatedAt)}` })),
          h('span', { class: current ? 'row-end row-end--accent' : 'row-end', text: current ? 'Current' : 'Open' })));
    }));
  }
};

const SettingsUI = {
  init() {
    $$('[data-setting]').forEach((control) => {
      control.addEventListener('change', () => this.onChange(control));
    });
    $$('[data-action]').forEach((btn) => btn.addEventListener('click', () => this.onAction(btn.dataset.action)));

    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: light)');
      const listener = () => { if (State.settings.theme === 'system') applyTheme(); };
      if (query.addEventListener) query.addEventListener('change', listener);
      else if (query.addListener) query.addListener(listener);
    }
  },

  sync() {
    $$('[data-setting]').forEach((control) => {
      const key = control.dataset.setting;
      if (control.type === 'radio') control.checked = State.settings[key] === control.value;
      else control.checked = Boolean(State.settings[key]);
    });
    const hint = $('#notify-hint');
    if (hint) {
      hint.textContent = Notify.supported()
        ? 'Get notified when Kashvee replies while this tab is in the background.'
        : "Notifications aren't supported in this browser.";
    }
  },

  async onChange(control) {
    const key = control.dataset.setting;
    if (control.type === 'radio') {
      if (!control.checked) return;
      State.settings[key] = control.value;
    } else if (key === 'notifications' && control.checked) {
      const result = await Notify.enable();
      if (!result.ok) {
        control.checked = false;
        State.settings.notifications = false;
        Toast.show(result.message, { duration: 5500 });
      } else {
        State.settings.notifications = true;
      }
    } else {
      State.settings[key] = control.checked;
    }
    if (!saveSettings(State.settings)) Toast.show("Your browser couldn't save this setting. Check that storage is allowed.");
    applyTheme();
    applyStatusVisibility();
    ChatUI.refreshStatus();
  },

  async onAction(action) {
    if (action === 'clear-conversation') {
      if (!State.conversation.messages.length) { Toast.show('This conversation is already empty.'); return; }
      const ok = await Modal.confirm({
        title: 'Clear this conversation?',
        body: 'The messages in the current chat will be deleted. Your memories stay.',
        confirmLabel: 'Clear conversation'
      });
      if (!ok) return;
      Chat.clearCurrent();
      Toast.show('Conversation cleared.');
    } else if (action === 'clear-memories') {
      if (!getMemories().length) { Toast.show('There are no memories to clear.'); return; }
      const ok = await Modal.confirm({
        title: 'Clear all memories?',
        body: 'Kashvee will forget everything in the Memory tab. This can’t be undone.',
        confirmLabel: 'Clear memories'
      });
      if (!ok) return;
      clearMemories();
      MemoryUI.render();
      Toast.show('Memories cleared.');
    } else if (action === 'reset-app') {
      const ok = await Modal.confirm({
        title: 'Reset Kashvee?',
        body: 'This removes all conversations, memories, your profile and your settings from this device. This can’t be undone.',
        confirmLabel: 'Reset everything'
      });
      if (!ok) return;
      this.resetEverything();
    }
  },

  resetEverything() {
    Chat.cancelGeneration();
    resetAll();
    State.load();
    applyTheme();
    applyStatusVisibility();
    ChatUI.clearNotice();
    ChatUI.renderAll();
    ChatUI.els.input.value = '';
    ChatUI.autosize();
    ChatUI.updateSend();
    this.sync();
    Views.go('chat');
    Toast.show('Kashvee has been reset.');
  }
};

/* 11. Boot ------------------------------------------------------------------ */

const App = {
  lastErrorToast: 0,

  init() {
    StorageAdapter.init();
    State.load();
    applyTheme();
    applyStatusVisibility();

    Toast.init();
    Modal.init();
    ChatUI.init();
    MemoryUI.init();
    ProfileUI.init();
    SettingsUI.init();
    Views.init();
    Viewport.init();

    window.addEventListener('error', () => this.reportError());
    window.addEventListener('unhandledrejection', () => this.reportError());

    if (!StorageAdapter.persistent) {
      Toast.show("Your browser is blocking storage, so chats and memories won't be saved after you close this page.", { duration: 7000 });
    }
  },

  reportError() {
    const now = Date.now();
    if (now - this.lastErrorToast < 5000) return;
    this.lastErrorToast = now;
    Toast.show('Something went wrong. If it keeps happening, try Reset app in Settings.');
  }
};

if (typeof document !== 'undefined') {
  const start = () => {
    try {
      App.init();
    } catch (err) {
      console.error('[Kashvee] failed to start', err);
      document.body.append(h('p', { style: 'padding:24px;font-family:sans-serif;color:#ECECF2' },
        'Kashvee ran into a problem while starting. Reload the page. If it keeps happening, clear this site’s data in your browser settings.'));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
