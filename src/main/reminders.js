'use strict';

// Reminders and timers: understanding "remind me to call mum in 20 minutes",
// "set a timer for 5 minutes", "what reminders do I have?" and "cancel the
// timer", plus the little notebook (kept on disk) that holds them until they're
// due. No Electron in here, so all of it can be tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const when = require('./when');

const MAX_ACTIVE = 50;
const MAX_TEXT = 200;
const MAX_INPUT = 300;
const LATE_MS = 90_000; // later than this and a reminder counts as late
const ICON = { reminder: '⏰', timer: '⏱️' };

// ---------- reading what the user said ----------

function normalize(text) {
  return String(text ?? '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[  -​ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PREFIX =
  /^(?:(?:hey|hi|hello|ok|okay|yo)\s*,?\s+)?(?:nibo\s*[,!:]?\s+)?(?:(?:please|pls|can you|could you|would you|will you|can u|i need you to|i want you to|i'd like you to|i would like you to|go ahead and)\s*,?\s*)*/i;

const stripPrefix = (s) => s.replace(PREFIX, '');
const stripEnd = (s) => s.replace(/[\s.!?…]+$/, '');

const LEADING_FILLER = /^(to|that|about|of|for|and|then|please|pls|also|just|so|because|called|named|labelled|labeled|saying)\b[\s,:;.-]*/i;
const TRAILING_FILLER = /[\s,:;.-]+(?:please|pls|thanks|thank you|ok|okay|and|then|also|too|for me|will you|would you)$/i;

/** What's left of a sentence once the time is cut out: { text, connector }. */
function tidy(raw) {
  let text = String(raw).replace(/\s+/g, ' ').trim();
  let connector = '';
  for (let prev = null; prev !== text; ) {
    prev = text;
    text = text.replace(/^[\s,;:.\-–—!?]+/, '').replace(/[\s,;:\-–—]+$/, '');
    const m = LEADING_FILLER.exec(text);
    if (m) {
      if (!connector && /^(?:to|that|about|of)$/i.test(m[1])) connector = m[1].toLowerCase();
      text = text.slice(m[0].length);
    }
    text = text.replace(TRAILING_FILLER, '');
  }
  return { text: text.replace(/[.!]+$/, '').trim().slice(0, MAX_TEXT), connector };
}

const REMIND_LEAD = new RegExp(
  '^(?:' +
    [
      "(?:remind|ping|nudge|alert|notify|buzz)\\s+me\\b",
      'wake\\s+me(?:\\s+up)?\\b',
      '(?:set|create|make|add|schedule|put)\\s+(?:me\\s+)?(?:up\\s+)?(?:an?\\s+|the\\s+|my\\s+|another\\s+|new\\s+)?(?:reminder|alarm)s?\\b',
      '(?:new\\s+)?reminder\\b',
      "(?:don'?t|do\\s+not)\\s+let\\s+me\\s+forget\\b",
    ].join('|') +
    ')',
  'i',
);

const TIMER_NOUN = '(?:timer|countdown|count\\s*down)';
const TIMER_VERBS = '(?:set|start|make|create|begin|run|use|get|put\\s+on|add|do|give\\s+me|can\\s+i\\s+have)';
const DETERMINER = '(?:(?:an?|the|my|another|new)\\s+)';
const TIMER_SET = new RegExp(`^${TIMER_VERBS}\\s+(?:me\\s+|us\\s+)?${DETERMINER}?(?:[\\w.,'-]+\\s+){0,3}?${TIMER_NOUN}s?\\b`, 'i');
const TIMER_BARE = new RegExp(`^${DETERMINER}?(?:[\\w.,'-]+[\\s-]+){0,3}?${TIMER_NOUN}s?\\b`, 'i');
const TIMER_STRIP = new RegExp(`^\\s*(?:${TIMER_VERBS}\\s+(?:me\\s+|us\\s+)?)?${DETERMINER}?`, 'i');
const NOT_A_REQUEST = /^(?:of|how|what|who|where|why|which|whether|if)\b/i;
const REPEAT =
  /\bevery\s+(?:day|morning|evening|night|hour|week|month|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s+(?:minutes?|hours?|days?|weeks?))\b|\b(?:daily|weekly|monthly|hourly|nightly|everyday|recurring|repeating)\b|\beach\s+(?:day|morning|evening|night|week|month)\b/i;

function detectSet(body, now) {
  let kind = null;
  let rest = body;
  let wake = false;
  let alarm = false;
  const remind = REMIND_LEAD.exec(body);
  if (remind) {
    kind = 'reminder';
    rest = body.slice(remind[0].length);
    wake = /^wake/i.test(remind[0]);
    alarm = /alarm/i.test(remind[0]);
  } else if (TIMER_SET.test(body) || TIMER_BARE.test(body)) {
    kind = 'timer';
  }
  if (!kind) return null;
  if (REPEAT.test(rest)) return { type: 'unsupported', reason: 'repeat' };

  let found = when.parseWhen(rest, now, { timer: kind === 'timer', part: alarm ? 'morning' : null });
  if (!found && alarm) {
    // "set an alarm for 7": a bare hour is fine when that's all there is
    const hour = /^\s*(?:for\s+|at\s+)?(\d{1,2})\s*$/.exec(rest);
    const guess = hour && when.parseWhen(`at ${hour[1]}`, now, { part: 'morning' });
    if (guess) found = { ...guess, spans: [[0, rest.length]] };
  }
  if (kind === 'timer' && !found && !TIMER_SET.test(body)) return null; // "my timer is broken"

  let text;
  let connector = '';
  if (kind === 'timer') {
    const left = when.cut(rest, found ? found.spans : []).replace(TIMER_STRIP, '').replace(new RegExp(`\\b${TIMER_NOUN}s?\\b`, 'gi'), ' ');
    ({ text, connector } = tidy(left));
  } else {
    ({ text, connector } = tidy(when.cut(rest, found ? found.spans : [])));
  }
  if (!found && NOT_A_REQUEST.test(rest.trim())) return null; // "remind me how to tie a tie"
  if (!text) text = wake ? 'wake up' : alarm ? 'your alarm' : '';

  const base = { kind, text, connector };
  if (!found) {
    // A length of time is in there somewhere ("it takes 3 minutes"): the AI may know what it means.
    const timey = Boolean(when.findDuration(rest, { timer: true, bare: true }));
    return { type: 'ask-when', ...base, ...(timey ? { timey: true } : {}) };
  }
  if (!found.ok) return { type: 'bad-time', reason: found.reason, ...base };
  return { type: 'set', due: found.due, ...base };
}

// A reply to "when?": just a time ("in 10 minutes", "6pm", "10") and nothing else.
function bareTime(body, now) {
  let t = stripEnd(body);
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t
      .replace(/^(?:in|at|for|after|within|about|around|make it|let'?s say|say|maybe|like|um+|uh+|ok|okay|yes|yeah|yep|sure|please|pls|hmm+|well|just|how about|what about|try)\b[\s,]*/i, '')
      .replace(/[\s,]*(?:please|pls|thanks)$/i, '');
  }
  if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 1440) t = `${t} minutes`;
  const found = when.parseWhen(t, now, { bare: true });
  if (!found) return null;
  if (tidy(when.cut(t, found.spans)).text) return null;
  return found;
}

const SNOOZE = /^(?:snooze|(?:remind|ping|nudge|alert|notify)\s+me\s+(?:again|later|once\s+more))\b/i;
const SNOOZE_MORE = /^(?:give\s+me|gimme|i\s+need|can\s+i\s+have|just)?\s*(?:another\s+)?(.*?)\bmore\s+((?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b.*)$/i;

function detectSnooze(body, now) {
  let spec = null;
  if (SNOOZE.test(body)) spec = body.replace(SNOOZE, '');
  else if (/^(?:give\s+me\s+)?another\s+\S/i.test(body)) spec = body.replace(/^(?:give\s+me\s+)?/i, '');
  else {
    const more = SNOOZE_MORE.exec(body);
    if (more && /\d|\b(?:an?|one|two|three|four|five|ten|fifteen|twenty|thirty|half|couple|few)\b/i.test(more[1])) spec = `${more[1]} ${more[2]}`;
  }
  if (spec === null) return null;
  const found = when.findDuration(spec, { bare: true });
  const ms = found && found.ms > 0 ? Math.min(found.ms, 24 * when.HOUR) : /\blater\b/i.test(body) ? 10 * when.MINUTE : 5 * when.MINUTE;
  return { type: 'snooze', ms };
}

const NOUN = /\b(reminders?|timers?|alarms?|countdowns?)\b/i;
const CANCEL_VERB =
  /^(?:cancel|delete|remove|clear|stop|dismiss|turn\s+off|switch\s+off|disable|kill|end|abort|discard|get\s+rid\s+of|forget(?:\s+about)?|never\s*mind|nvm)\b/i;
const kindOfNoun = (noun) => (/timer|countdown/i.test(noun) ? 'timer' : 'reminder');

function detectCancel(body) {
  const verb = CANCEL_VERB.exec(body);
  if (!verb) return null;
  const rest = body.slice(verb[0].length);
  const noun = NOUN.exec(rest);
  if (!noun) return null;
  const all = /\b(?:all|every|everything)\b/i.test(rest) || /s$/i.test(noun[1]);
  const { text } = tidy(
    rest
      .replace(NOUN, ' ')
      .replace(
        /\b(?:all|every|each|any|my|the|that|this|those|these|last|latest|previous|current|running|active|pending|upcoming|about|on|for|to|of|called|named|please|pls|now|again|anymore|i|set|made|you|just|from|and)\b/gi,
        ' ',
      ),
  );
  return { type: 'cancel', kind: kindOfNoun(noun[1]), all, text };
}

const LIST_START =
  /^(?:what|which|whats|what's|what are|do i have|have i got|am i|how many|how much|how long|show|list|see|check|tell me|any|are there|is there|got any|view|open|read)\b/i;

function detectList(body) {
  if (!NOUN.test(body)) return null;
  if (/\bhow\s+(?:do|can|could|would|should|to)\b/i.test(body)) return null;
  if (/^what(?:'s|\s+is|\s+are)\s+an?\s+(?:reminder|timer|alarm|countdown)/i.test(body)) return null;
  if (LIST_START.test(body) || /^(?:my\s+)?(?:reminders?|timers?|alarms?|countdowns?)$/i.test(body)) return { type: 'list' };
  return null;
}

/**
 * What does the user want, reminder-wise? One of
 *   { type: 'set', kind, text, connector, due }       a reminder or timer to keep
 *   { type: 'ask-when', kind, text, connector }       clear intent, but no time yet
 *   { type: 'bad-time', reason, kind, text, connector } a time that can't be used
 *   { type: 'unsupported', reason: 'repeat' }
 *   { type: 'list' } | { type: 'cancel', kind, all, text } | { type: 'snooze', ms }
 * or null when it isn't about reminders at all.
 * opts.pending: { kind, text } if Nibo just asked "when?", so a bare "in 10 minutes" answers it.
 */
function detect(text, { now = new Date(), pending = null } = {}) {
  const s = normalize(text);
  if (!s || s.length > MAX_INPUT) return null;
  const body = stripEnd(stripPrefix(s));
  if (!body) return null;

  if (pending) {
    if (pending.text) {
      const found = bareTime(body, now);
      if (found) {
        const base = { kind: pending.kind, text: pending.text, connector: pending.connector || '' };
        return found.ok ? { type: 'set', due: found.due, ...base } : { type: 'bad-time', reason: found.reason, ...base };
      }
    } else if (pending.kind === 'reminder') {
      // "What should I remind you about, and when?" -> "call mum in 20 minutes"
      const full = detectSet(`remind me ${body}`, now);
      if (full && full.type !== 'unsupported') return full;
    } else {
      const found = bareTime(body, now);
      if (found) return found.ok ? { type: 'set', due: found.due, kind: 'timer', text: '', connector: '' } : { type: 'bad-time', reason: found.reason, kind: 'timer', text: '', connector: '' };
    }
  }

  return detectSnooze(body, now) || detectCancel(body) || detectList(body) || detectSet(body, now);
}

/** Like detect, for the "Remind me…" prompt, where "call mum in 20 min" and "5 minutes" are fine on their own. */
function detectFromPrompt(text, { now = new Date(), pending = null } = {}) {
  const s = normalize(text);
  if (!s) return null;
  const direct = detect(s, { now, pending });
  if (direct) return direct;
  const body = stripEnd(stripPrefix(s));
  const bare = bareTime(body, now);
  if (bare) {
    const kind = bare.how === 'absolute' ? 'reminder' : 'timer';
    return bare.ok ? { type: 'set', due: bare.due, kind, text: '', connector: '' } : { type: 'bad-time', reason: bare.reason, kind, text: '', connector: '' };
  }
  return detect(`remind me ${s}`, { now });
}

/** The time in a phrase like "in 20 minutes", for the AI's set_reminder tool. */
function parsePhrase(phrase, { now = new Date(), timer = false } = {}) {
  const t = stripEnd(normalize(phrase));
  const bare = bareTime(t, now);
  if (bare) return bare;
  return when.parseWhen(t, now, { timer, bare: true });
}

// ---------- the notebook ----------

const newId = () => crypto.randomBytes(4).toString('hex');

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const due = Number(raw.due);
  if (!Number.isFinite(due)) return null;
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
  const id = typeof raw.id === 'string' && /^[a-z0-9]{4,32}$/i.test(raw.id) ? raw.id : newId();
  const created = Number.isFinite(Number(raw.created)) ? Number(raw.created) : due;
  return { id, kind: raw.kind === 'timer' ? 'timer' : 'reminder', text, due, created };
}

class ReminderBook {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.items = [];
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run, or an unreadable file: start with an empty notebook
    }
    const seen = new Set();
    this.items = [];
    for (const entry of Array.isArray(raw && raw.items) ? raw.items : []) {
      const item = sanitize(entry);
      if (!item || seen.has(item.id) || this.items.length >= MAX_ACTIVE) continue;
      seen.add(item.id);
      this.items.push(item);
    }
    this.sort();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[nibo] could not save reminders:', err.message);
    }
  }

  sort() {
    this.items.sort((a, b) => a.due - b.due || a.created - b.created);
  }

  list() {
    return [...this.items];
  }

  get(id) {
    return this.items.find((i) => i.id === id) || null;
  }

  /** Adds one. Returns it, or null when the notebook is full. */
  add({ kind = 'reminder', text = '', due }) {
    if (this.items.length >= MAX_ACTIVE) return null;
    const item = sanitize({ kind, text, due, created: this.now() });
    if (!item) return null;
    this.items.push(item);
    this.sort();
    this.save();
    return item;
  }

  remove(id) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return null;
    const [item] = this.items.splice(index, 1);
    this.save();
    return item;
  }

  /** Removes everything (or just one kind). Returns what was removed. */
  clear(kind = null) {
    const gone = this.items.filter((i) => !kind || i.kind === kind);
    if (!gone.length) return [];
    this.items = this.items.filter((i) => kind && i.kind !== kind);
    this.save();
    return gone;
  }

  /** Removes and returns everything that is due by now, oldest first. */
  takeDue(now = this.now()) {
    const due = this.items.filter((i) => i.due <= now);
    if (!due.length) return [];
    this.items = this.items.filter((i) => i.due > now);
    this.save();
    return due;
  }
}

/** The items a "cancel the pasta timer" could mean. */
function matchItems(items, { kind = null, text = '' } = {}) {
  const pool = kind ? items.filter((i) => i.kind === kind) : items;
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (!words.length) return pool;
  const scored = pool.map((item) => ({ item, hits: words.filter((w) => item.text.toLowerCase().includes(w)).length })).filter((x) => x.hits);
  const best = Math.max(0, ...scored.map((x) => x.hits));
  return scored.filter((x) => x.hits === best).map((x) => x.item);
}

// ---------- what Nibo says ----------

const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const labelOf = (item) => item.text || (item.kind === 'timer' ? 'Timer' : 'Reminder');
const shorten = (text, n = 22) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Button text for one item; timers get their end time so two of them can be told apart.
const chipLabel = (item) =>
  item.kind === 'timer'
    ? `${shorten(labelOf(item), 12)} (${new Date(item.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })})`
    : shorten(labelOf(item), 18);

function confirmText(item, intent, now = new Date()) {
  const dueText = when.describeDue(new Date(item.due), now);
  if (item.kind === 'timer') {
    const tag = item.text ? ` (${item.text})` : '';
    const wait = item.due - now.getTime();
    if (wait < when.DAY) {
      return `Timer set for ${when.formatDuration(wait)}${tag}! ⏱️ I'll shout at ${when.formatClock(new Date(item.due))}.`;
    }
    return `Timer set${tag}: ${dueText}! ⏱️`;
  }
  const what = item.text ? ` ${intent.connector ? `${intent.connector} ${item.text}` : `about “${item.text}”`}` : '';
  return `Okay! I'll remind you${what} ${dueText}. ⏰`;
}

const BAD_TIME = {
  past: 'That time has already passed! ⏳ Try a time later today, or say “tomorrow at 9”.',
  far: "That's too far away for my little bunny brain! 🐰 I can remember things for about a year.",
  zero: "Hmm, that's right now! 😄 Try something like “in 5 minutes”.",
  baddate: "Hmm, I couldn't find that date on my calendar. 📅",
};

const badTimeText = (reason) => BAD_TIME[reason] || BAD_TIME.past;

/** The question for an intent that has no time yet, with quick answers as buttons. */
function askWhen(intent) {
  if (intent.kind === 'timer') {
    const label = intent.text ? ` for “${shorten(intent.text, 30)}”` : '';
    return {
      text: `How long should the timer${label} run? ⏱️`,
      actions: [['1 min', '1 minute'], ['5 min', '5 minutes'], ['10 min', '10 minutes'], ['25 min', '25 minutes']].map(([name, length]) => ({
        label: `⏱️ ${name}`,
        action: 'ask',
        arg: `set a timer for ${length}${intent.text ? ` for ${intent.text}` : ''}`,
      })),
    };
  }
  if (!intent.text) {
    return { text: 'Sure! What should I remind you about, and when? ⏰ Like “call mum in 20 minutes”.', actions: [] };
  }
  const base = `remind me ${intent.connector ? `${intent.connector} ` : ''}${intent.text}`;
  return {
    text: `Sure! When should I remind you ${intent.connector || 'about'} “${shorten(intent.text, 40)}”? ⏰ Try “in 20 minutes”, “at 6pm” or “tomorrow at 9”.`,
    actions: [
      { label: 'In 10 min', action: 'ask', arg: `${base} in 10 minutes` },
      { label: 'In 1 hour', action: 'ask', arg: `${base} in 1 hour` },
      { label: 'Tomorrow 9 AM', action: 'ask', arg: `${base} tomorrow at 9am` },
    ],
  };
}

/** The list for "what reminders do I have?", with a ✖️ button for each. */
function describeList(items, now = Date.now()) {
  if (!items.length) {
    return {
      text: "I'm not holding any reminders or timers right now. 🐰 Try “remind me to stretch in 20 minutes” or “set a timer for 5 minutes”.",
      actions: [],
    };
  }
  const shown = items.slice(0, 6);
  const lines = shown.map((i) => `${ICON[i.kind]} ${labelOf(i)}: ${when.describeDue(new Date(i.due), new Date(now))}`);
  if (items.length > shown.length) lines.push(`…and ${items.length - shown.length} more`);
  const actions = shown.slice(0, 4).map((i) => ({ label: `✖️ ${chipLabel(i)}`, action: 'reminder-cancel', arg: i.id }));
  if (items.length > 1) actions.push({ label: '🧹 Cancel all', action: 'reminder-cancel-all' });
  return { text: ["Here's what I'm keeping track of:", ...lines].join('\n'), actions };
}

function duePhrase(due, now) {
  const day = when.formatDay(new Date(due), new Date(now));
  const clock = when.formatClock(new Date(due));
  return day === 'today' ? `at ${clock}` : `${day} at ${clock}`;
}

function lineFor(item, now) {
  const late = now - item.due > LATE_MS;
  let written;
  let spoken;
  if (item.kind === 'timer') {
    written = `⏱️ Time's up${item.text ? `: ${item.text}` : '!'}`;
    spoken = item.text ? `Time's up! ${capital(item.text)}.` : "Time's up!";
  } else {
    written = item.text ? `⏰ Reminder: ${item.text}` : '⏰ Here is your reminder!';
    spoken = item.text ? `Reminder: ${item.text}.` : 'Here is your reminder!';
  }
  if (late) written += ` (that was due ${duePhrase(item.due, now)})`;
  return { written, spoken, late };
}

const MAX_ALERT_LINES = 5;

/** What Nibo shows and says when these items go off: { text, speech }. */
function alertContent(items, now = Date.now()) {
  const lines = items.map((item) => lineFor(item, now));
  const sorry = lines.some((l) => l.late) ? "Sorry I'm late! " : '';
  if (lines.length === 1) return { text: lines[0].written, speech: sorry + lines[0].spoken };
  const more = lines.length - MAX_ALERT_LINES;
  return {
    text: ['Heads up! 🐰', ...lines.slice(0, MAX_ALERT_LINES).map((l) => `• ${l.written}`), ...(more > 0 ? [`…and ${more} more`] : [])].join('\n'),
    speech: `${sorry}Heads up! ${lines.slice(0, 3).map((l) => l.spoken).join(' ')}${lines.length > 3 ? ` And ${lines.length - 3} more.` : ''}`,
  };
}

module.exports = {
  ICON,
  LATE_MS,
  MAX_ACTIVE,
  MAX_TEXT,
  ReminderBook,
  alertContent,
  askWhen,
  badTimeText,
  chipLabel,
  confirmText,
  describeList,
  detect,
  detectFromPrompt,
  labelOf,
  matchItems,
  parsePhrase,
  shorten,
};
