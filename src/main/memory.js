'use strict';

// What Nibo remembers about the user: a short list of notes ("Their name is Sam",
// "Has a dog called Biscuit"), kept on this computer in memory.json. The user can
// see them, add to them and delete them, and Nibo only adds one when he is told to
// or says so. Plain logic, no Electron, so it can be tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NOTES = 60;
const MAX_NOTE = 300;
const MIN_NOTE = 3;
const MAX_INPUT = 500;
const PROMPT_CHARS = 1800; // how much of the notebook goes along with a question

// ---------- what is not for keeping ----------

const SECRET_WORDS = /\b(?:password|passcode|passphrase|pin(?:\s+(?:code|number))?|cvv|cvc|api[\s-]?key|secret(?:\s+key)?|private\s+key|access\s+token|auth(?:entication)?\s+token|2fa|one[\s-]time\s+code|recovery\s+(?:code|phrase)|seed\s+phrase|social\s+security|ssn|iban|routing\s+number|credit\s+card|card\s+number)\b/i;
const KEY_SHAPES = /\b(?:gsk_|tvly-|sk-|ghp_|github_pat_|xox[bp]-|AKIA)[\w-]{8,}|\b\d{3}-\d{2}-\d{4}\b/i;
const LONG_NUMBER = /(?:\d[\s-]?){13,19}/;

/** Passwords, card numbers, keys: Nibo won't keep those. */
function looksSecret(text) {
  return SECRET_WORDS.test(text) || KEY_SHAPES.test(text) || LONG_NUMBER.test(text);
}

function tidyNote(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:that|how)\s+/i, '')
    .replace(/[\s,;:]+$/, '')
    .slice(0, MAX_NOTE)
    .trim();
}

const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
// (A lone digit counts: "has 2 dogs" and "has 3 dogs" are different notes.)
const words = (text) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 || /\d/.test(w));

// Words that don't say which note is meant.
const FILLER = new Set(['the', 'and', 'for', 'about', 'that', 'this', 'with', 'have', 'has', 'was', 'are', 'you', 'your', 'they', 'their', 'them', 'from', 'what', 'who', 'told', 'said', 'know', 'remember', 'note', 'notes', 'thing', 'stuff', 'everything']);

// Two notes that say (nearly) the same thing.
function sameNote(a, b) {
  const x = words(a).join(' ');
  const y = words(b).join(' ');
  return Boolean(x) && (x === y || (Math.min(x.length, y.length) > 12 && (x.includes(y) || y.includes(x))));
}

// ---------- the notebook ----------

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
  const text = tidyNote(raw.text);
  if (text.length < MIN_NOTE) return null;
  const id = typeof raw.id === 'string' && /^[a-z0-9]{4,32}$/i.test(raw.id) ? raw.id : crypto.randomBytes(4).toString('hex');
  const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0;
  return { id, text, at };
}

class Memory {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.notes = [];
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run, or an unreadable file: an empty notebook
    }
    const seen = new Set();
    this.notes = [];
    for (const entry of Array.isArray(raw && raw.notes) ? raw.notes : []) {
      const note = sanitize(entry);
      if (!note || seen.has(note.id) || this.notes.length >= MAX_NOTES) continue;
      seen.add(note.id);
      this.notes.push(note);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, notes: this.notes }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[nibo] could not save the notebook:', err.message);
    }
  }

  /** Oldest first. */
  list() {
    return [...this.notes];
  }

  get count() {
    return this.notes.length;
  }

  get(id) {
    return this.notes.find((n) => n.id === id) || null;
  }

  /**
   * Keeps a note. Resolves { ok: true, note } or { ok: false, reason } with reason
   * 'empty' | 'secret' | 'duplicate' | 'full'.
   */
  add(text) {
    const said = tidyNote(text);
    if (said.length < MIN_NOTE) return { ok: false, reason: 'empty' };
    if (looksSecret(said)) return { ok: false, reason: 'secret' };
    const clean = capital(said);
    const twin = this.notes.find((n) => sameNote(n.text, clean));
    if (twin) return { ok: false, reason: 'duplicate', note: twin };
    if (this.notes.length >= MAX_NOTES) return { ok: false, reason: 'full' };
    const note = sanitize({ text: clean, at: this.now() });
    this.notes.push(note);
    this.save();
    return { ok: true, note };
  }

  /** The user's name replaces an older one instead of piling up. */
  setName(name) {
    const old = this.notes.filter((n) => /^their name is\b/i.test(n.text));
    const res = this.add(`Their name is ${name}`);
    if (res.ok) {
      this.notes = this.notes.filter((n) => !old.includes(n));
      this.save();
    } else if (res.reason === 'duplicate') {
      res.ok = true; // same name again: nothing to do
    }
    return res;
  }

  name() {
    const note = this.notes.find((n) => /^their name is\b/i.test(n.text));
    return note ? note.text.replace(/^their name is\s+/i, '').trim() : '';
  }

  remove(id) {
    const index = this.notes.findIndex((n) => n.id === id);
    if (index < 0) return null;
    const [note] = this.notes.splice(index, 1);
    this.save();
    return note;
  }

  clear() {
    const gone = this.notes;
    this.notes = [];
    if (gone.length) this.save();
    return gone;
  }

  /** The notes a "forget my dog" could mean: those with the most words in common. */
  find(text) {
    const wanted = words(text).filter((w) => !FILLER.has(w));
    if (!wanted.length) return [];
    const scored = this.notes.map((note) => ({ note, hits: wanted.filter((w) => note.text.toLowerCase().includes(w)).length })).filter((x) => x.hits);
    const best = Math.max(0, ...scored.map((x) => x.hits));
    return scored.filter((x) => x.hits === best).map((x) => x.note);
  }

  /** The notes as lines for the AI, newest first when there are too many. */
  forPrompt(maxChars = PROMPT_CHARS) {
    const lines = [];
    let used = 0;
    for (const note of [...this.notes].reverse()) {
      if (used + note.text.length + 3 > maxChars) break;
      lines.unshift(note.text);
      used += note.text.length + 3;
    }
    return lines;
  }
}

// ---------- what the user says ----------

const PREFIX = /^(?:(?:hey|hi|hello|ok|okay|yo)\s*,?\s+)?(?:nibo\s*[,!:]?\s+)?(?:(?:please|pls|can you|could you|would you|will you|can u)\s*,?\s*)*/i;
const STOP_NAMES = new Set(['later', 'back', 'tomorrow', 'today', 'tonight', 'now', 'soon', 'maybe', 'when', 'if', 'please', 'anytime', 'again', 'sometime', 'whenever', 'it', 'that', 'this', 'you', 'me', 'them', 'him', 'her', 'the', 'a', 'an', 'at', 'on', 'in', 'for', 'up', 'out', 'over', 'around', 'once', 'whatever', 'something', 'someone', 'nothing', 'anything', 'ok', 'okay', 'what', 'who', 'why', 'how']);

function normalize(text) {
  return String(text ?? '')
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(raw, { needCapital }) {
  const name = String(raw)
    .replace(/[.!?,;:]+$/, '')
    .replace(/\s+(?:please|thanks|thank you|ok|okay|from now on|instead|then)$/i, '')
    .trim();
  const parts = name.split(/\s+/);
  if (!name || parts.length > 3 || name.length > 30) return null;
  if (!parts.every((p) => /^[\p{L}][\p{L}'.-]*$/u.test(p))) return null;
  if (parts.some((p) => STOP_NAMES.has(p.toLowerCase()))) return null;
  if (needCapital && !/^\p{Lu}/u.test(parts[0])) return null;
  return parts.map((p) => (/^\p{Ll}/u.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

const NAME_IS = /^(?:(?:hi|hello|hey)\s*,?\s+)?(?:my\s+name\s+is|my\s+name's|i\s+am\s+called|i'm\s+called|everyone\s+calls\s+me|they\s+call\s+me|people\s+call\s+me)\s+(.+)$/i;
const CALL_ME = /^(?:(?:from\s+now\s+on|you\s+can|just|please)\s*,?\s+)*call\s+me\s+(.+)$/i;
const REMEMBER = /^(?:remember|note|keep\s+in\s+mind|make\s+a\s+note|take\s+note|don't\s+forget|do\s+not\s+forget|from\s+now\s+on)\b[\s:,-]*(.*)$/i;
const SHOW = [
  /\bwhat\s+(?:do|did|would)\s+you\s+(?:remember|know)\s+(?:about\s+me|of\s+me|so\s+far)\b/i,
  /\bwhat\s+(?:do|did)\s+you\s+remember\s*$/i,
  /\bwhat\s+have\s+i\s+(?:told|said\s+to)\s+you\b/i,
  /\b(?:show|open|see|list|view|read)\s+(?:me\s+)?(?:your|nibo's|the)?\s*(?:memory|memories|notes?|notebook)\b/i,
  /\bwhat(?:'s|\s+is)\s+in\s+your\s+(?:memory|notebook|notes)\b/i,
  /\bwhat\s+do\s+you\s+know\s+about\s+(?:me|myself)\b/i,
];
const FORGET_ALL = [
  /^forget\s+(?:everything|all)(?:\s+(?:that\s+)?(?:you\s+know(?:\s+about\s+me)?|i\s+(?:told|said)(?:\s+to)?\s+you|about\s+me|of\s+(?:it|that)))?$/i,
  /^forget\s+(?:me|about\s+me|who\s+i\s+am)$/i,
  /^(?:clear|erase|wipe|empty|delete|reset)\s+(?:all\s+)?(?:of\s+)?(?:your|the)\s+(?:memory|memories|notes|notebook)$/i,
  /^forget\s+(?:all\s+)?(?:your\s+)?(?:memory|memories|notes)$/i,
];

/**
 * What does the user want, memory-wise?
 *   { type: 'name', name }            "call me Sam", "my name is Sam"
 *   { type: 'remember', text }        "remember that I love cats"
 *   { type: 'show' }                  "what do you remember about me?"
 *   { type: 'forget', all: true }     "forget everything"
 *   { type: 'forget', last: true }    "forget that"
 *   { type: 'forget', text }          "forget my name"
 * or null.
 */
function detect(text) {
  const s = normalize(text);
  if (!s || s.length > MAX_INPUT) return null;
  const body = s.replace(PREFIX, '').replace(/[\s.!?…]+$/, '');
  if (!body) return null;

  const name = NAME_IS.exec(body);
  if (name) {
    const clean = cleanName(name[1], { needCapital: false });
    return clean ? { type: 'name', name: clean } : null;
  }
  const call = CALL_ME.exec(body);
  if (call) {
    const clean = cleanName(call[1], { needCapital: true });
    return clean ? { type: 'name', name: clean } : null;
  }

  if (SHOW.some((re) => re.test(body))) return { type: 'show' };

  if (FORGET_ALL.some((re) => re.test(body))) return { type: 'forget', all: true };
  const forget = /^(?:forget|never\s*mind|nvm)\s+(?:about\s+)?(.+)$/i.exec(body);
  if (forget) {
    const what = forget[1].replace(/^(?:that\s+)?/i, '').trim();
    if (/^(?:that|it|this|that\s+one|the\s+last\s+(?:thing|one)|what\s+i\s+just\s+(?:said|told\s+you))$/i.test(what)) return { type: 'forget', last: true };
    if (/^forget\b/i.test(body) && what) return { type: 'forget', text: what.slice(0, 120) };
  }
  if (/^forget\s+(?:that|it)$/i.test(body)) return { type: 'forget', last: true };

  const remember = REMEMBER.exec(body);
  if (remember) {
    const rest = remember[1].trim();
    // "remember to call mum" is a reminder; "don't forget about it" is not a note.
    if (!rest || /^(?:to|about|me\b|when|how|what|who|where|why|which|if)\b/i.test(rest)) return null;
    const lead = /^from\s+now\s+on/i.test(remember[0]) ? 'From now on, ' : '';
    return { type: 'remember', text: `${lead}${rest}` };
  }
  return null;
}

module.exports = {
  MAX_INPUT,
  MAX_NOTE,
  MAX_NOTES,
  Memory,
  detect,
  looksSecret,
  sameNote,
  tidyNote,
};
