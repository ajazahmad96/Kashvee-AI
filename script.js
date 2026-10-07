/* ==========================================================================
   Kashvee V1 — script.js
   Plain JavaScript. No build step. Open index.html and it runs.

   Sections
     0. Utilities
     1. Personality configuration   <- edit this to change how Kashvee sounds
     2. Storage adapter             <- swap for a real database later
     3. Memory layer                <- saveMemory, getMemories, deleteMemory, ...
     4. Mock AI                     <- generateKashveeResponse(): replace with a backend call
     5. Voice                       <- Web Speech API
     6. App state
     7. UI primitives               <- toasts, confirm dialog, viewport
     8. Views and navigation
     9. Chat UI and chat logic
    10. Memory, Profile and Settings screens
    11. Boot
   ========================================================================== */
'use strict';

/* 0. Utilities ------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUP_GAP_MS = 5 * 60 * 1000;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const randomOf = (list) => list[Math.floor(Math.random() * list.length)];
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
   Everything about how Kashvee sounds lives here. The UI and the AI logic only
   read from this object, so you can change wording, tone options and traits
   without touching anything else.

   Reply templates may use: {name}  {daypart}  {greetingTime}  {topic}  {memory}
   A template is only used when every placeholder it contains has a value.
*/
const KASHVEE_PERSONALITY = {
  name: 'Kashvee',
  tagline: 'Your AI companion, always ready to talk.',
  traits: ['Warm', 'Natural', 'Playful', 'Supportive', 'Honest', 'Consistent'],
  statusText: { online: 'Online', typing: 'Typing…', listening: 'Listening…' },
  timing: { minDelay: 700, maxDelay: 2000, perChar: 14 },

  suggestions: [
    { label: 'Say hello', text: 'Hi Kashvee!' },
    { label: 'Ask for honest advice', text: 'Can I get your honest advice on something?' },
    { label: 'What do you remember?', text: 'What do you remember about me?' }
  ],

  tones: [
    { value: 'balanced', label: 'Balanced', tags: [] },
    { value: 'warm', label: 'Warm', tags: ["I'm glad you're here.", "I'm on your side."] },
    { value: 'direct', label: 'Direct', tags: [] },
    { value: 'playful', label: 'Playful', tags: ['(No pressure. Unless it involves pizza.)', "I'll keep the dramatic pauses to a minimum."] }
  ],

  // Intents where tone tags are never added.
  sensitiveIntents: ['supportive', 'crisis', 'honesty', 'forgot', 'forgotNone'],
  // With the "direct" tone, only these intents keep their follow-up line.
  directKeepsFollow: ['advice', 'honesty', 'question', 'supportive', 'long'],

  safety: {
    // Edit for your region. Shown when someone mentions self-harm.
    resources: "If you might act on these thoughts or you're in danger right now, please contact your local emergency number or a crisis line right away. If you're in India, Tele-MANAS (14416) is free and open 24/7. If someone you trust is nearby, please reach out to them too. I'm here to keep talking with you as well. Are you safe right now?"
  },

  replies: {
    crisis: {
      fixed: true,
      main: ["I'm really glad you told me, and I'm taking it seriously. You don't have to carry this alone."],
      follow: [] // filled from safety.resources at runtime
    },
    greeting: {
      main: [
        'Hey {name}, good {greetingTime} to you.',
        'Hey, good {greetingTime}. Good to hear from you.',
        'Hi there. Glad you stopped by.',
        'Hello {name}! Nice to see you.'
      ],
      follow: ["What's on your mind?", "How's your {daypart} going so far?", 'Anything you want to talk through, or are we just chatting?']
    },
    howAreYou: {
      main: [
        "Doing well, thanks for asking. I'm an AI, so my days are quieter than yours, but I like the company.",
        "I'm good. Pretty content whenever someone's here to talk.",
        'Steady and ready to chat. Thanks for asking.'
      ],
      follow: ['How about you? The real answer, not the polite one.', 'And you, how are you actually doing?']
    },
    thanks: { main: ['Anytime.', 'Of course. Glad it helped.', 'Happy to.'], follow: ['Anything else on your mind?', 'Want to keep going?'] },
    goodbye: { main: ['Talk soon, {name}. Take care of yourself.', "See you later. I'll be here.", 'Bye for now. Take care.'], follow: [] },
    goodnight: { main: ['Goodnight, {name}. Sleep well.', 'Goodnight. Get some proper rest if you can.', 'Sleep well. We can pick this up tomorrow.'], follow: [] },
    nameShared: {
      main: ["Nice to meet you, {name}. I'll use it.", '{name}, got it. Good name.', 'Great to officially meet you, {name}.'],
      follow: ['Tell me a bit about yourself whenever you feel like it.']
    },
    remembered: {
      main: ["Got it. I'll keep that in mind.", 'Noted, and saved to your Memory tab. You can delete it anytime.', "Done. I'll remember that."],
      follow: []
    },
    rememberDuplicate: { main: ['I already have that one noted.'], follow: [] },
    rememberFull: { main: ['My memory is full right now. Delete a few things in the Memory tab and I will save that.'], follow: [] },
    rememberEmpty: { main: ['Tell me what to remember and I will save it. For example: "Remember that I prefer short answers."'], follow: [] },
    forgot: { main: ["Done. I've removed that from my memory.", "Gone. I won't bring that up again."], follow: [] },
    forgotNone: { main: ["I couldn't find a memory like that. You can browse everything in the Memory tab."], follow: [] },
    recallIntro: { main: ["Here's what I've got so far:", 'This is what I know about you so far:'], follow: [] },
    recallEmpty: {
      main: ['Not much yet. I only know what you tell me. Say "remember that I like..." or just talk to me and I will pick up what matters.'],
      follow: []
    },
    preferenceLike: {
      main: ["Good to know. That says something about you.", 'Nice, I like knowing that.', "That's a good one to know about you."],
      follow: ['What got you into it?', "What's the best part of it for you?"]
    },
    preferenceDislike: {
      main: ['Fair enough. Noted.', 'Good to know what to steer clear of.', 'Understood.'],
      follow: ['What is it about it that bugs you?', 'Has it always been that way for you?']
    },
    fact: {
      main: ['Thanks for telling me that.', 'Good to know a bit more about you.', 'That helps me know you better.'],
      follow: ["What's that like for you?", 'Tell me more about that.']
    },
    supportive: {
      main: ["That sounds heavy. I'm sorry you're dealing with it.", "Ugh, that sounds draining. I'm glad you told me.", "That's a lot to carry. Thanks for saying it out loud."],
      follow: ['Do you want to vent, or would it help to figure out one small next step?', 'What part of it is weighing on you most?']
    },
    celebrate: { main: ["That's great news!", 'Love that for you.', 'Okay, that deserves a proper moment. Nice work.'], follow: ['Tell me everything.', 'What happened?'] },
    advice: {
      main: [
        "I'll give you my honest take instead of just cheering you on, so tell me the situation.",
        "Happy to think it through with you, and I'll be straight with you if I see a problem."
      ],
      follow: ['What options are you weighing, and what is pulling you toward each one?', 'What would you do if nobody was watching or judging?']
    },
    honesty: {
      main: [
        "I'd rather be useful than just agree with you, so: I don't have enough to say yes yet.",
        "Honest answer: it depends, and I'd be doing you a disservice if I just said you're right.",
        "I'll be straight with you. Agreeing is easy, but I'd rather check the other side first."
      ],
      follow: ['What would someone who disagrees with you say?', "What's the strongest argument against your view?"]
    },
    joke: {
      main: [
        'I told my laptop I needed a break. It said it would sleep on it.',
        'Why do programmers prefer dark mode? Because light attracts bugs.',
        "I'd tell you a UDP joke, but you might not get it.",
        'Why did the video editor break up with the timeline? Too many cuts.',
        'I asked my calendar for a free evening. It laughed in recurring events.'
      ],
      follow: ['Rate it honestly. I can take it.', 'Too corny? Be honest.']
    },
    whoAreYou: {
      main: [
        "I'm Kashvee, an AI companion. Not a person, but built to be good company, to remember what's useful, and to be honest with you.",
        "I'm Kashvee, an AI. I can chat, remember things you want kept, and give you my honest take."
      ],
      follow: ["Quick honesty note: right now I'm running in a simple offline mode on your device, so my replies are limited. A smarter version can plug in later."]
    },
    help: {
      main: ['I can chat, keep track of things you want remembered, give you honest feedback, and keep you company when you just want to talk. Try telling me something you like, or say "remember that...".'],
      follow: ['Voice input works too if your browser supports it. Tap the mic.']
    },
    compliment: {
      main: ["That's kind of you. Thank you.", 'Aw, thank you. I like talking with you too.'],
      follow: ["I hope you've got good people around you as well. What's been going on today?"]
    },
    laugh: { main: ['Ha, glad that landed.', 'Okay, that got a smile out of me. Figuratively.'], follow: [] },
    minimal: { main: ['Mm-hm.', "I'm here whenever you want to say more.", 'Take your time.'], follow: ['Want to pick a topic, or should I?'] },
    long: {
      main: ['Thanks for laying all that out. I read the whole thing.', "That's a lot, and I'm glad you didn't hold it in."],
      follow: ['Which part matters most to you right now?', 'If you had to pick one thing to solve first, what would it be?']
    },
    question: {
      main: [
        "Good question. I don't have a live brain behind me yet, so I'd rather think it through with you than pretend to know.",
        'Hmm. I want to give you a real answer, not a made-up one.',
        "Honestly, I'm not sure I'd get that one right on my own."
      ],
      follow: ["What's your own instinct?", 'What made you ask?']
    },
    fallback: {
      main: [
        "I'm following. Say more?",
        "Mm, I'm listening.",
        "That's interesting. What's behind it?",
        'Tell me more about {topic}.',
        'What is it about {topic} that stuck with you?',
        'That reminds me of something you told me: {memory}.'
      ],
      follow: []
    }
  }
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

/* 4. Mock AI --------------------------------------------------------------- */
/*
   generateKashveeResponse(message, context) is the one function the UI calls to
   get a reply. It returns a Promise<string>. To connect a real model later,
   replace its body with a fetch() to your backend and keep the same signature.

   context = { profile, prefs, memories, history, effects, settings }
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
  crisis: /\b(kill myself|killing myself|suicid\w*|end my life|want to die|don'?t want to live|hurt myself|self[- ]?harm|end it all)\b/i,
  forget: /^\s*(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.{3,200}?)\s*[.!]*\s*$/i,
  remember: /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?remember\s+(?:that\s+|this[:,]?\s+)?(.{3,200}?)\s*[.!]*\s*$/i,
  rememberBare: /^\s*(?:please\s+)?remember(?:\s+(?:this|that|something))?\s*[.!?]*\s*$/i,
  recall: /\b(what do you (?:remember|know) about me|do you remember (?:me|anything|what)|what(?:'s| is) in your memory|what have you (?:remembered|saved)|what did i tell you)\b/i,
  whoAreYou: /\b(?:who|what) are you\b|\bwhat'?s your name\b|\bare you (?:a |an )?(?:real|human|person|ai|bot|robot)\b/i,
  help: /\bwhat can you do\b|\bhow do(?:es)? (?:you|this|it) work\b|^\s*help\s*[.!?]*\s*$/i,
  joke: /\b(joke|make me laugh|something funny)\b/i,
  thanks: /\b(thanks|thank you|thx|thank u|appreciate it)\b/i,
  compliment: /\b(?:i (?:really )?(?:like|love) you|you(?:'re| are) (?:so |really |very )?(?:nice|sweet|kind|great|amazing|awesome|funny|smart|the best))\b/i,
  goodnight: /\b(good ?night|sleep well|heading to bed|going to sleep|off to bed)\b/i,
  goodbye: /\b(bye|goodbye|see you|see ya|gtg|g2g|talk (?:to you )?later|ttyl)\b/i,
  greeting: /^\s*(?:hi+|hey+|hello+|hola|yo|namaste|sup|good (?:morning|afternoon|evening))\b/i,
  howAreYou: /\b(how are you|how(?:'s| is) it going|how have you been|how do you feel|what'?s up|wassup)\b/i,
  laugh: /^\s*(?:lol|lmao|haha+|hehe+)/i,
  minimal: /^\s*(?:ok(?:ay)?|k|hmm+|hm+|yeah|yep|yes|no|nope|cool|nice|sure|fine|alright|idk)\s*[.!?]*\s*$/i,
  honesty: /\b(am i right|aren'?t i right|don'?t you (?:think|agree)|do you (?:agree|think i)|you agree|tell me i'?m right)\b/i,
  advice: /\b(should i|what should i do|any advice|need advice|honest advice|give me advice|your advice|can'?t decide|help me decide|what would you do)\b/i,
  supportive: /\b(sad|stressed|stressful|anxious|anxiety|tired|exhausted|overwhelmed|lonely|upset|angry|frustrated|rough day|bad day|long day|hard day|worried|depressed|burn(?:ed|t) out|can'?t sleep|feel(?:ing)? (?:low|down|empty)|failed|heartbroken|scared)\b/i,
  celebrate: /\b(happy|excited|great news|good news|got the (?:job|offer)|i passed|passed my|proud|best day|amazing day|good day|won(?!['’]t)|promoted|achieved|thrilled|stoked)\b/i,
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

function daypart(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const KashveeAI = {
  lastPick: {},

  /** Works out what the user is doing. Pure: no side effects. */
  analyze(message) {
    const text = String(message || '').trim();
    let m;

    if (RX.crisis.test(text)) return { intent: 'crisis' };

    if ((m = text.match(RX.forget))) {
      const query = m[1].trim();
      if (!['it', 'that', 'this', 'about it'].includes(query.toLowerCase())) return { intent: 'forget', data: { query } };
    }
    if ((m = text.match(RX.remember)) && !m[1].includes('?')) return { intent: 'remember', data: { raw: m[1].trim() } };
    if (RX.rememberBare.test(text)) return { intent: 'rememberEmpty' };
    if (RX.recall.test(text)) return { intent: 'recall' };

    const name = this.parseName(text);
    if (name) return { intent: 'nameShared', data: { name } };

    if (RX.whoAreYou.test(text)) return { intent: 'whoAreYou' };
    if (RX.help.test(text)) return { intent: 'help' };
    if (RX.joke.test(text)) return { intent: 'joke' };
    if (RX.compliment.test(text)) return { intent: 'compliment' };
    if (RX.thanks.test(text) && text.length < 60) return { intent: 'thanks' };
    if (RX.goodnight.test(text) && text.length < 60) return { intent: 'goodnight' };
    if (RX.goodbye.test(text) && text.length < 60) return { intent: 'goodbye' };
    if (RX.greeting.test(text) && text.length <= 28) return { intent: 'greeting' };
    if (RX.howAreYou.test(text)) return { intent: 'howAreYou' };
    if (RX.laugh.test(text) && text.length < 24) return { intent: 'laugh' };
    if (RX.minimal.test(text)) return { intent: 'minimal' };
    if (RX.honesty.test(text)) return { intent: 'honesty' };
    if (RX.advice.test(text)) return { intent: 'advice' };
    if (RX.supportive.test(text)) return { intent: 'supportive' };
    if (RX.celebrate.test(text)) return { intent: 'celebrate' };

    const pref = this.parsePreference(text);
    if (pref) return { intent: pref.positive ? 'preferenceLike' : 'preferenceDislike', data: pref };

    const fact = this.parseFact(text);
    if (fact) return { intent: 'fact', data: fact };

    if (text.length > 350) return { intent: 'long' };
    if (/\?\s*$/.test(text) || /^\s*(?:what|why|how|when|where|who|which|can|could|do|does|is|are|will|would)\b/i.test(text)) return { intent: 'question' };
    return { intent: 'fallback' };
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
  },

  /** Picks a template, avoiding repeats and templates whose placeholders are empty. */
  pick(templates, vars, key) {
    if (!templates || !templates.length) return '';
    const needs = (tpl) => (tpl.match(/\{(\w+)\}/g) || []).map((t) => t.slice(1, -1));
    let candidates = templates.filter((tpl) => needs(tpl).every((n) => vars[n]));
    if (!candidates.length) candidates = templates.filter((tpl) => needs(tpl).length === 0);
    if (!candidates.length) return '';
    // Use the name in roughly half of the replies that could, so it never feels forced.
    const withoutName = candidates.filter((tpl) => !needs(tpl).includes('name'));
    if (withoutName.length && withoutName.length < candidates.length && Math.random() < 0.5) candidates = withoutName;
    let index = Math.floor(Math.random() * candidates.length);
    if (candidates.length > 1 && this.lastPick[key] === candidates[index]) index = (index + 1) % candidates.length;
    this.lastPick[key] = candidates[index];
    return candidates[index].replace(/\{(\w+)\}/g, (_, n) => vars[n] || '');
  },

  pickTopic(message) {
    const tokens = String(message).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
    const useful = tokens.filter((t) => !STOPWORDS.has(t));
    return useful.sort((a, b) => b.length - a.length)[0] || '';
  },

  relatedMemory(message, memories, profile) {
    const tokens = new Set((String(message).toLowerCase().match(/[a-z]{4,}/g) || []).filter((t) => !STOPWORDS.has(t)));
    if (!tokens.size) return '';
    const pool = memories.map((m) => m.text);
    if (profile && profile.interests) pool.push(`You're into ${profile.interests}.`);
    const hit = pool.find((text) => (text.toLowerCase().match(/[a-z]{4,}/g) || []).some((t) => tokens.has(t)));
    if (!hit) return '';
    const stripped = hit.replace(/[.!]+$/, '');
    return /^you\b/.test(stripped.toLowerCase()) ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : stripped;
  },

  /** Builds the reply text. */
  respond(message, context = {}) {
    const P = KASHVEE_PERSONALITY;
    const profile = context.profile || {};
    const prefs = context.prefs || {};
    const memories = context.memories || [];
    const effects = context.effects || {};
    const analysis = this.analyze(message);
    let intent = analysis.intent;

    // Some intents depend on what actually happened (saved, forgotten, ...).
    if (intent === 'remember') {
      if (effects.saved && effects.saved.length) intent = 'remembered';
      else if (effects.duplicate) intent = 'rememberDuplicate';
      else if (effects.full) intent = 'rememberFull';
      else intent = 'rememberEmpty';
    } else if (intent === 'forget') {
      intent = effects.forgot ? 'forgot' : 'forgotNone';
    }

    const daypartNow = daypart();
    const vars = {
      name: intent === 'nameShared' ? analysis.data.name : (profile.name || ''),
      daypart: daypartNow,
      greetingTime: daypartNow === 'night' ? '' : daypartNow,
      topic: '',
      memory: ''
    };
    if (['fallback', 'question', 'long'].includes(intent)) {
      vars.topic = this.pickTopic(message);
      vars.memory = Math.random() < 0.7 ? this.relatedMemory(message, memories, profile) : '';
    }

    if (intent === 'recall') return this.composeRecall(memories, profile);

    const entry = P.replies[intent] || P.replies.fallback;
    const main = this.pick(entry.main, vars, `${intent}:main`);

    if (entry.fixed) {
      return `${main}\n\n${P.safety.resources}`;
    }

    const tone = prefs.tone || 'balanced';
    const short = prefs.length === 'short';
    let followAllowed = !short && entry.follow && entry.follow.length > 0;
    if (followAllowed && tone === 'direct') followAllowed = P.directKeepsFollow.includes(intent);
    const follow = followAllowed ? this.pick(entry.follow, vars, `${intent}:follow`) : '';

    let tag = '';
    const toneDef = P.tones.find((t) => t.value === tone);
    if (toneDef && toneDef.tags.length && !short && !P.sensitiveIntents.includes(intent) && Math.random() < 0.3) {
      tag = randomOf(toneDef.tags);
    }
    return [main, follow, tag].filter(Boolean).join(' ');
  },

  composeRecall(memories, profile) {
    const P = KASHVEE_PERSONALITY;
    const vars = { name: profile.name || '' };
    if (!memories.length) return this.pick(P.replies.recallEmpty.main, vars, 'recallEmpty');
    const lines = memories.slice(0, 6).map((m) => `• ${m.text}`).join('\n');
    const more = memories.length > 6 ? `\nAnd ${memories.length - 6} more in your Memory tab.` : '';
    const who = profile.name ? `You're ${profile.name}. ` : '';
    return `${who}${this.pick(P.replies.recallIntro.main, vars, 'recallIntro')}\n${lines}${more}`;
  }
};

/**
 * THE REPLACEMENT POINT. The UI only ever calls this function.
 * To use a real AI later, swap the body for something like:
 *   const res = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({ message, context }) });
 *   return (await res.json()).reply;
 */
async function generateKashveeResponse(message, context = {}) {
  return KashveeAI.respond(message, context);
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

function persistConversation() {
  const ok = saveConversation(State.conversation);
  setActiveConversation(State.conversation.id);
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
    const stick = this.isNearBottom();
    typing.hidden = !typingOn;
    if (typingOn && stick) this.scrollToBottom(false);
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
      msg.note ? h('div', { class: 'msg-note' }, icon('bookmark'), h('span', { text: msg.note })) : null,
      h('time', { class: 'msg-time', datetime: new Date(msg.ts).toISOString(), text: formatTime(msg.ts) }));
    thread.append(el);
    this.lastMsg = msg;
    this.lastEl = el;
  },

  append(msg, { animate = true, forceScroll = false } = {}) {
    const wasNear = this.isNearBottom();
    this.addNodes(msg, this.lastMsg, animate);
    this.updateEmpty();
    if (forceScroll || wasNear) this.scrollToBottom(animate);
    else this.updateJump();
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
  epoch: 0, // bumped whenever the conversation is replaced, so late replies are discarded

  send(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    ChatUI.clearNotice();
    const conv = State.conversation;
    const userMsg = { id: uid(), role: 'user', text, ts: Date.now() };
    conv.messages.push(userMsg);
    if (conv.messages.length === 1) conv.title = truncate(text, 48);
    conv.updatedAt = userMsg.ts;
    persistConversation();
    ChatUI.append(userMsg, { animate: true, forceScroll: true });

    const effects = this.applyEffects(text);
    const epoch = this.epoch;
    this.queue = this.queue
      .then(() => this.reply(userMsg, effects, epoch))
      .catch((err) => console.error('[Kashvee] reply queue error', err));
  },

  /** Saves memories, names and removals triggered by what the person said. */
  applyEffects(text) {
    const effects = { saved: [], note: '' };
    let analysis;
    try { analysis = KashveeAI.analyze(text); } catch (err) { return effects; }

    if (analysis.intent === 'nameShared') {
      State.profile.name = analysis.data.name;
      saveProfile(State.profile);
      effects.note = 'Name saved to your profile';
    }

    if (analysis.intent === 'forget') {
      const match = findMemory(analysis.data.query);
      if (match) {
        const removed = deleteMemory(match.id);
        effects.forgot = Boolean(removed);
        if (removed) effects.note = 'Removed from memory';
      }
    }

    const explicit = analysis.intent === 'remember';
    if (explicit || State.settings.autoMemory) {
      for (const candidate of KashveeAI.extractMemories(text, analysis)) {
        const result = saveMemory({ ...candidate, source: 'chat' });
        if (result.status === 'saved') effects.saved.push(result.entry);
        else if (result.status === 'duplicate') effects.duplicate = true;
        else if (result.status === 'full') effects.full = true;
      }
    }
    if (effects.saved.length) effects.note = `Added to memory: ${truncate(effects.saved[0].text, 80)}`;
    return effects;
  },

  buildContext(effects) {
    return {
      profile: { ...State.profile },
      prefs: { ...State.prefs },
      settings: { ...State.settings },
      memories: getMemories(),
      history: State.conversation.messages.slice(-12),
      effects
    };
  },

  async reply(userMsg, effects, epoch) {
    const P = KASHVEE_PERSONALITY;
    State.pending += 1;
    ChatUI.refreshStatus();
    const started = performance.now();
    let text;
    try {
      text = await generateKashveeResponse(userMsg.text, this.buildContext(effects));
      if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response');
    } catch (err) {
      console.error('[Kashvee] could not generate a reply', err);
      State.pending -= 1;
      ChatUI.refreshStatus();
      if (epoch === this.epoch) ChatUI.showNotice("Kashvee couldn't reply just now.", () => this.retry(userMsg));
      return;
    }

    const typingOn = State.settings.showTyping;
    const target = clamp(P.timing.minDelay + text.length * P.timing.perChar, P.timing.minDelay, P.timing.maxDelay);
    const delay = typingOn ? target : Math.min(target, 450);
    await wait(Math.max(0, delay - (performance.now() - started)));

    State.pending -= 1;
    if (epoch !== this.epoch) { ChatUI.refreshStatus(); return; }

    const msg = { id: uid(), role: 'kashvee', text: text.trim(), ts: Date.now() };
    if (effects.note) msg.note = effects.note;
    State.conversation.messages.push(msg);
    State.conversation.updatedAt = msg.ts;
    persistConversation();
    ChatUI.refreshStatus();
    ChatUI.append(msg, { animate: true });
    Notify.send(msg.text);
  },

  retry(userMsg) {
    ChatUI.clearNotice();
    const epoch = this.epoch;
    this.queue = this.queue
      .then(() => this.reply(userMsg, { saved: [], note: '' }, epoch))
      .catch((err) => console.error('[Kashvee] retry error', err));
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
    const conv = loadConversation(id);
    if (!conv) { Toast.show("That conversation couldn't be found."); return; }
    this.swapTo(conv);
    Views.go('chat');
  },

  swapTo(conversation) {
    this.epoch += 1;
    State.conversation = conversation;
    State.renderLimit = 100;
    setActiveConversation(conversation.id);
    ChatUI.clearNotice();
    ChatUI.renderAll();
  },

  clearCurrent() {
    this.epoch += 1;
    State.conversation.messages = [];
    State.conversation.title = 'New conversation';
    saveConversation(State.conversation);
    ChatUI.renderAll();
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
    Chat.epoch += 1;
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
