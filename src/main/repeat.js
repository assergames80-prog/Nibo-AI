'use strict';

// Repeating reminders: "every day at 9", "every weekday", "every monday and thursday
// at 6:30pm", "every 2 hours", "every month on the 15th", "every year on march 3".
// A rule says how it repeats; firstDue/advance say when it rings next. Plain logic,
// no Electron, so it can be tested with a made-up clock.

const when = require('./when');

const MINUTE = when.MINUTE;
const HOUR = when.HOUR;
const MIN_INTERVAL_MS = 5 * MINUTE; // more often than this is nagging, not reminding
const UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'];
const CAPS = { minute: 24 * 60, hour: 24 * 7, day: 366, week: 52, month: 24, year: 1 };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 0];
const PART_AT = { morning: [9, 0], afternoon: [15, 0], evening: [18, 0], night: [21, 0] };

// ---------- the rule ----------

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

/**
 * { unit, every, at?: [h, m], weekdays?: [0-6], dom?: 1-31, month?: 0-11 } or null.
 * unit: minute | hour (a plain interval), day | week | month | year (at a time of day).
 */
function sanitizeRule(raw) {
  if (!raw || typeof raw !== 'object' || !UNITS.includes(raw.unit)) return null;
  const every = Number(raw.every ?? 1);
  if (!isInt(every, 1, CAPS[raw.unit])) return null;
  const rule = { unit: raw.unit, every };
  if (raw.unit === 'minute' || raw.unit === 'hour') {
    return every * (raw.unit === 'hour' ? HOUR : MINUTE) >= MIN_INTERVAL_MS ? rule : null;
  }
  if (raw.at !== undefined) {
    if (!Array.isArray(raw.at) || !isInt(raw.at[0], 0, 23) || !isInt(raw.at[1], 0, 59)) return null;
    rule.at = [raw.at[0], raw.at[1]];
  }
  if (raw.unit === 'week') {
    const days = [...new Set(Array.isArray(raw.weekdays) ? raw.weekdays : [])];
    if (!days.length || !days.every((d) => isInt(d, 0, 6))) return null;
    rule.weekdays = days.sort((a, b) => a - b);
    if (every > 1 && days.length > 1) return null;
  }
  if (raw.unit === 'month' || raw.unit === 'year') {
    if (!isInt(raw.dom, 1, 31)) return null;
    rule.dom = raw.dom;
    if (raw.unit === 'year') {
      if (!isInt(raw.month, 0, 11)) return null;
      rule.month = raw.month;
    }
  }
  return rule;
}

const stepMs = (rule) => rule.every * (rule.unit === 'hour' ? HOUR : MINUTE);

// ---------- when it rings ----------

const atTime = (date, h, m) => {
  const d = new Date(date.getTime());
  d.setHours(h, m, 0, 0);
  return d;
};
const addDays = (date, n) => {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
};
// The given day of a month (clamped to its last day: the 31st of April is the 30th).
function monthDate(year, monthIndex, dom, h, m) {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(dom, last), h, m, 0, 0);
}

/** The first time it rings, strictly after `now`. */
function firstDue(rule, now = new Date()) {
  if (rule.unit === 'minute' || rule.unit === 'hour') return new Date(now.getTime() + stepMs(rule));
  const [h, m] = rule.at;
  if (rule.unit === 'day') {
    const today = atTime(now, h, m);
    return today > now ? today : atTime(addDays(now, 1), h, m);
  }
  if (rule.unit === 'week') {
    for (let k = 0; k <= 7; k++) {
      const d = atTime(addDays(now, k), h, m);
      if (rule.weekdays.includes(d.getDay()) && d > now) return d;
    }
  }
  if (rule.unit === 'month') {
    for (let k = 0; k < 26; k++) {
      const d = monthDate(now.getFullYear(), now.getMonth() + k, rule.dom, h, m);
      if (d > now) return d;
    }
  }
  if (rule.unit === 'year') {
    for (let y = now.getFullYear(); y <= now.getFullYear() + 2; y++) {
      const d = monthDate(y, rule.month, rule.dom, h, m);
      if (d > now) return d;
    }
  }
  return new Date(now.getTime() + 24 * HOUR);
}

/**
 * After it rang at `due` (maybe late: the computer was asleep, or Nibo was off), the
 * next time it should ring: on schedule, and after `now`. Missed ones are skipped,
 * so a week away doesn't mean seven rings.
 */
function advance(rule, due, now = new Date()) {
  const dueDate = new Date(due);
  if (rule.unit === 'minute' || rule.unit === 'hour') {
    const step = stepMs(rule);
    const k = Math.max(1, Math.floor((now.getTime() - dueDate.getTime()) / step) + 1);
    return new Date(dueDate.getTime() + k * step);
  }
  const [h, m] = rule.at;
  if (rule.unit === 'week' && (rule.every === 1 || rule.weekdays.length > 1)) {
    return firstDue(rule, now > dueDate ? now : dueDate);
  }
  let d = dueDate;
  for (let guard = 0; guard < 5000; guard++) {
    if (rule.unit === 'day') d = atTime(addDays(d, rule.every), h, m);
    else if (rule.unit === 'week') d = atTime(addDays(d, 7 * rule.every), h, m);
    else if (rule.unit === 'month') d = monthDate(d.getFullYear(), d.getMonth() + rule.every, rule.dom, h, m);
    else d = monthDate(d.getFullYear() + 1, rule.month, rule.dom, h, m);
    if (d > now) return d;
  }
  return firstDue(rule, now);
}

// ---------- saying it ----------

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;

function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "every day at 9:00 AM", "every weekday at 9:00 AM", "every 2 hours". */
function describeRule(rule) {
  const clock = rule.at ? ` at ${when.formatClock(atTime(new Date(2026, 0, 5), rule.at[0], rule.at[1]))}` : '';
  const n = rule.every;
  if (rule.unit === 'minute' || rule.unit === 'hour') return `every ${n === 1 ? rule.unit : `${when.formatDuration(stepMs(rule))}`}`;
  if (rule.unit === 'day') return `every ${n === 1 ? 'day' : `${n} days`}${clock}`;
  if (rule.unit === 'week') {
    const days = rule.weekdays;
    const same = (set) => days.length === set.length && set.every((d) => days.includes(d));
    if (days.length === 7) return `every day${clock}`;
    if (n === 1) {
      if (same(WEEKDAYS)) return `every weekday${clock}`;
      if (same(WEEKEND)) return `every weekend${clock}`;
      return `every ${listNames(days.map((d) => DAY_NAMES[d]))}${clock}`;
    }
    return `every ${n} weeks on ${DAY_NAMES[days[0]]}${clock}`;
  }
  if (rule.unit === 'month') return `every ${n === 1 ? 'month' : `${n} months`} on the ${ordinal(rule.dom)}${clock}`;
  return `every year on ${when.MONTH_NAMES[rule.month][0].toUpperCase()}${when.MONTH_NAMES[rule.month].slice(1)} ${rule.dom}${clock}`;
}

// ---------- understanding it ----------

const NUM = `(?:\\d+(?:[.,]\\d+)?|${when.NUMBER_WORD}|an?|couple\\s+of|few)`;
const DAY_WORD = '(?:monday|mon|tuesday|tues?|wednesday|wed|thursday|thurs?|thu|friday|fri|saturday|sat|sunday|sun)';
const DAY_LIST = `(?:weekdays?|weekends?|${DAY_WORD})(?:\\s*(?:,|and|&|\\+)\\s*(?:and\\s+)?(?:weekdays?|weekends?|${DAY_WORD}))*`;
const PLURAL_DAY = '(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays|weekends)';
const PART = '(?:\\s+(?:in\\s+the\\s+)?(morning|afternoon|evening|night)\\b)?';
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
// "daily at 9", "daily to take pills", "remind me weekly": a repeat. But "the daily
// standup" and "my weekly planner" use the word as part of a name, so only count it
// when it ends the sentence or is followed by a word that carries on about timing.
const ADVERB_ENDS = '(?=\\s*$|\\s*[,.!?]|\\s+(?:at|on|to|that|about|for|and|please|before|after|around|by|in|starting|from|during)\\b|\\s+\\d)';

function weekdaysOf(list) {
  const days = new Set();
  for (const word of list.toLowerCase().split(/\s*(?:,|and|&|\+)\s*/).filter(Boolean)) {
    if (/^weekdays?$/.test(word)) WEEKDAYS.forEach((d) => days.add(d));
    else if (/^weekends?$/.test(word)) WEEKEND.forEach((d) => days.add(d));
    else {
      const index = DAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(word.replace(/s$/, '').slice(0, 3)));
      if (index >= 0) days.add(index);
    }
  }
  return [...days];
}

// Each handler: [regex, (match, now) => rule | null, dayPart?]. The first that matches wins.
const HANDLERS = [
  // on the 15th of every month, the 1st of each month
  [
    /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b/gi,
    (m) => ({ unit: 'month', every: 1, dom: Number(m[1]) }),
  ],
  // every half hour, every quarter of an hour
  [/\bevery\s+(half|quarter)(?:\s+of)?(?:\s+an?)?\s+hour\b/gi, (m) => ({ unit: 'minute', every: /half/i.test(m[1]) ? 30 : 15 })],
  // every 2 hours, every other day, every minute, every week
  [
    new RegExp(`\\bevery\\s+(?:(other)|(${NUM}))?\\s*(minute|hour|day|week|month|year)s?\\b`, 'gi'),
    (m) => {
      let every = m[1] ? 2 : m[2] ? when.numberOf(m[2]) : 1;
      let unit = m[3].toLowerCase();
      if (unit === 'hour' && !Number.isInteger(every)) {
        every = Math.round(every * 60);
        unit = 'minute';
      }
      return { unit, every };
    },
  ],
  // every monday, every monday and thursday, every weekday, on weekends
  [
    new RegExp(`\\b(?:(?:every|each)\\s+(${DAY_LIST})|on\\s+(${PLURAL_DAY}(?:\\s*(?:,|and|&)\\s*${PLURAL_DAY})*))${PART}`, 'gi'),
    (m) => ({ unit: 'week', every: 1, weekdays: weekdaysOf(m[1] || m[2]) }),
  ],
  // every morning, every evening
  [new RegExp(`\\bevery\\s+(morning|afternoon|evening|night)\\b`, 'gi'), () => ({ unit: 'day', every: 1 })],
  // daily, weekly, monthly, yearly, hourly, nightly
  [
    new RegExp(`\\b(daily|weekly|monthly|yearly|annually|hourly|nightly)\\b${ADVERB_ENDS}`, 'gi'),
    (m) => ({ unit: { daily: 'day', nightly: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annually: 'year', hourly: 'hour' }[m[1].toLowerCase()], every: 1 }),
  ],
];

const END_CONDITION =
  /\b(?:until|till|for\s+(?:the\s+next\s+)?(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple)\s+(?:more\s+)?(?:days?|weeks?|months?|years?|times)|\d+\s+times|(?:once|twice)\s+(?:a|per)\s+(?:day|week))\b/i;

/**
 * Finds a repeat in a sentence. Returns null, or
 *   { rule, spans, phrase, needsTime, endCondition }
 * `rule.at` is missing (and needsTime true) when it repeats by the day, week, month or
 * year but no time of day was given. `phrase` is what the user said ("every weekday").
 */
function parseRepeat(text, now = new Date()) {
  const str = String(text);
  let hit = null;
  for (const [re, read] of HANDLERS) {
    re.lastIndex = 0;
    const m = re.exec(str);
    if (!m) continue;
    const base = read(m);
    if (!base) continue;
    hit = { base, start: m.index, end: m.index + m[0].length };
    break;
  }
  if (!hit) return null;

  const spans = [[hit.start, hit.end]];
  const rule = { ...hit.base };
  // A part of the day: "every morning", "every friday evening", "nightly".
  const partWord = /\bevery\s+(morning|afternoon|evening|night)\b/i.exec(str) || (/\bnightly\b/i.test(str) ? [null, 'night'] : null) || /\b(?:every|each|on)\s+\w+(?:\s*(?:,|and|&)\s*\w+)*\s+(?:in\s+the\s+)?(morning|afternoon|evening|night)\b/i.exec(str);
  const part = partWord ? partWord[1].toLowerCase() : null;

  const phraseSpans = () => spans.filter((span) => span !== clockSpan);
  let clockSpan = null;
  const clock = when.findClock(str);
  if (clock) {
    clockSpan = [clock.start, clock.end];
    spans.push(clockSpan);
    const [h] = when.hourChoices(clock, part);
    rule.at = [h, clock.m];
  } else if (part) {
    rule.at = [...PART_AT[part]];
  }

  if (rule.unit === 'month' || rule.unit === 'year') {
    // "on the 15th", "on march 3rd", "3 march"
    const ord = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(str);
    const dm = new RegExp(`\\bon\\s+${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(str) || null;
    const md = new RegExp(`\\bon\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'i').exec(str) || null;
    if (rule.unit === 'year' && (dm || md)) {
      rule.month = when.monthIndex(dm ? dm[1] : md[2]);
      rule.dom = Number(dm ? dm[2] : md[1]);
      spans.push([(dm || md).index, (dm || md).index + (dm || md)[0].length]);
    } else if (ord) {
      rule.dom = rule.dom || Number(ord[1]);
      if (!spans.some(([s, e]) => ord.index >= s && ord.index < e)) {
        const on = /\bon\s+$/i.exec(str.slice(0, ord.index));
        spans.push([on ? on.index : ord.index, ord.index + ord[0].length]);
      }
    }
    rule.dom = rule.dom || now.getDate();
    if (rule.unit === 'year') rule.month = rule.month ?? now.getMonth();
  }
  if (rule.unit === 'week' && !rule.weekdays) {
    // "weekly on friday", "every other week on monday": the weekday is named after; else it's today's
    const named = new RegExp(`\\b(?:on\\s+)?(${DAY_LIST})\\b`, 'i').exec(str);
    rule.weekdays = named ? weekdaysOf(named[1]) : [now.getDay()];
    if (named) spans.push([named.index, named.index + named[0].length]);
  }

  const needsTime = ['day', 'week', 'month', 'year'].includes(rule.unit) && !rule.at;
  const clean = sanitizeRule(needsTime ? { ...rule, at: [0, 0] } : rule);
  if (!clean) {
    const tooOften = (rule.unit === 'minute' || rule.unit === 'hour') && rule.every * (rule.unit === 'hour' ? HOUR : MINUTE) < MIN_INTERVAL_MS;
    return { rule: null, spans, phrase: str.slice(hit.start, hit.end).trim(), reason: tooOften ? 'too-often' : 'too-far' };
  }
  if (needsTime) delete clean.at;
  return {
    rule: clean,
    spans,
    phrase: phraseSpans().sort((a, b) => a[0] - b[0]).map(([a, b]) => str.slice(a, b).trim()).join(' '),
    needsTime,
    endCondition: END_CONDITION.test(str),
  };
}

module.exports = {
  MIN_INTERVAL_MS,
  advance,
  describeRule,
  firstDue,
  ordinal,
  parseRepeat,
  sanitizeRule,
};
